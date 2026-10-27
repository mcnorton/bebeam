// 프레임 타입별 payload 직렬화/파싱 (ARCHITECTURE §5.3)
//   평문: HELLO, DATA, ACK, CANCEL
//   암호문: INFO, ACCEPT, DONE, RESULT → iv(12) ‖ AES-GCM 암호문(태그 16 포함). 내용은 crypto.js가 다룬다
// 파서는 예외를 던지지 않고 null을 돌려준다. 모든 길이를 상한과 비교한다.

import { LIMITS } from '../installer/validate.js';

export const ROLE = Object.freeze({ SENDER: 1, RECEIVER: 2 });

export const PUBKEY_SIZE = 65; // P-256 비압축 공개키 (0x04 ‖ X ‖ Y)
export const NONCE_SIZE = 16;
export const DEVICE_NAME_MAX = 24; // UTF-8 바이트
export const IV_SIZE = 12;
export const TAG_SIZE = 16;
export const SEALED_MAX = 1024; // 암호 프레임 하나의 암호문 상한
export const WINDOW_BLOCKS = 256;
export const BITMAP_BYTES = WINDOW_BLOCKS / 8;
export const DATA_HEADER = 5; // startBlock(4) + count(1)
export const ACK_SIZE = 4 + BITMAP_BYTES + 1;
export const MAX_BLOCKS_PER_FRAME = 64;

export const CANCEL_REASON = Object.freeze({
  USER: 1, // 사용자가 [취소]/[거절]
  TIMEOUT: 2,
  VERIFY_FAILED: 3,
  ROLE_CONFLICT: 4,
  TOO_LARGE: 5,
});

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 바이트 기준으로 자르되 문자 중간에서 끊지 않는다 */
export function truncateUtf8(text, maxBytes) {
  let out = new Uint8Array(0);
  let s = '';
  for (const ch of String(text ?? '')) {
    const next = te.encode(s + ch);
    if (next.length > maxBytes) break;
    s += ch;
    out = next;
  }
  return out;
}

// ───────── HELLO ─────────
// role(1) ‖ peerSid(4) ‖ pubkey(65) ‖ nonce(16) ‖ nameLen(1) ‖ name(≤24)

/** @param {{role: number, peerSid: number, pubkey: Uint8Array, nonce: Uint8Array, deviceName?: string}} h */
export function encodeHello({ role, peerSid, pubkey, nonce, deviceName = '' }) {
  if (pubkey.length !== PUBKEY_SIZE || nonce.length !== NONCE_SIZE) throw new RangeError('hello key/nonce size');
  const name = truncateUtf8(deviceName, DEVICE_NAME_MAX);
  const p = new Uint8Array(1 + 4 + PUBKEY_SIZE + NONCE_SIZE + 1 + name.length);
  const v = new DataView(p.buffer);
  p[0] = role;
  v.setUint32(1, peerSid >>> 0);
  p.set(pubkey, 5);
  p.set(nonce, 5 + PUBKEY_SIZE);
  p[5 + PUBKEY_SIZE + NONCE_SIZE] = name.length;
  p.set(name, 6 + PUBKEY_SIZE + NONCE_SIZE);
  return p;
}

/** @returns {{role: number, peerSid: number, pubkey: Uint8Array, nonce: Uint8Array, deviceName: string} | null} */
export function decodeHello(p) {
  const fixed = 6 + PUBKEY_SIZE + NONCE_SIZE;
  if (!(p instanceof Uint8Array) || p.length < fixed) return null;
  const role = p[0];
  if (role !== ROLE.SENDER && role !== ROLE.RECEIVER) return null;
  const nameLen = p[fixed - 1];
  if (nameLen > DEVICE_NAME_MAX || p.length !== fixed + nameLen) return null;
  const pubkey = p.slice(5, 5 + PUBKEY_SIZE);
  if (pubkey[0] !== 0x04) return null;
  let deviceName;
  try {
    deviceName = td.decode(p.subarray(fixed, fixed + nameLen));
  } catch {
    return null;
  }
  return {
    role,
    peerSid: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(1),
    pubkey,
    nonce: p.slice(5 + PUBKEY_SIZE, fixed - 1),
    deviceName,
  };
}

// ───────── 암호 payload 공통 (INFO, ACCEPT, DONE, RESULT) ─────────

/** @param {{iv: Uint8Array, ct: Uint8Array}} s */
export function encodeSealed({ iv, ct }) {
  if (iv.length !== IV_SIZE || ct.length < TAG_SIZE || ct.length > SEALED_MAX) throw new RangeError('sealed size');
  const p = new Uint8Array(IV_SIZE + ct.length);
  p.set(iv);
  p.set(ct, IV_SIZE);
  return p;
}

/** @returns {{iv: Uint8Array, ct: Uint8Array} | null} */
export function decodeSealed(p) {
  if (!(p instanceof Uint8Array) || p.length < IV_SIZE + TAG_SIZE || p.length > IV_SIZE + SEALED_MAX) return null;
  return { iv: p.slice(0, IV_SIZE), ct: p.slice(IV_SIZE) };
}

// ───────── DATA ─────────
// startBlock(4) ‖ count(1) ‖ 블록 바이트. 마지막 블록만 짧을 수 있다

/** @param {{startBlock: number, count: number, bytes: Uint8Array}} d */
export function encodeData({ startBlock, count, bytes }) {
  if (count < 1 || count > MAX_BLOCKS_PER_FRAME) throw new RangeError('data count');
  const p = new Uint8Array(DATA_HEADER + bytes.length);
  new DataView(p.buffer).setUint32(0, startBlock >>> 0);
  p[4] = count;
  p.set(bytes, DATA_HEADER);
  return p;
}

/**
 * @param {Uint8Array} p
 * @param {{blockSize: number, totalBlocks: number, lastBlockSize: number}} layout 수신자가 INFO로 알게 된 값
 * @returns {{startBlock: number, count: number, bytes: Uint8Array} | null}
 */
export function decodeData(p, { blockSize, totalBlocks, lastBlockSize }) {
  if (!(p instanceof Uint8Array) || p.length < DATA_HEADER + 1) return null;
  const startBlock = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
  const count = p[4];
  if (count < 1 || count > MAX_BLOCKS_PER_FRAME || startBlock >= totalBlocks || startBlock + count > totalBlocks) return null;
  const includesLast = startBlock + count === totalBlocks;
  const expected = (includesLast ? (count - 1) * blockSize + lastBlockSize : count * blockSize);
  if (p.length !== DATA_HEADER + expected) return null;
  return { startBlock, count, bytes: p.subarray(DATA_HEADER) };
}

// ───────── ACK ─────────
// base(4: 이 값 미만은 모두 수신) ‖ bitmap(32: base부터 256블록) ‖ densityHint(1)

/** @param {{base: number, bitmap: Uint8Array, densityHint: number}} a */
export function encodeAck({ base, bitmap, densityHint }) {
  if (bitmap.length !== BITMAP_BYTES) throw new RangeError('ack bitmap');
  const p = new Uint8Array(ACK_SIZE);
  new DataView(p.buffer).setUint32(0, base >>> 0);
  p.set(bitmap, 4);
  p[ACK_SIZE - 1] = densityHint;
  return p;
}

/** @returns {{base: number, bitmap: Uint8Array, densityHint: number} | null} */
export function decodeAck(p) {
  if (!(p instanceof Uint8Array) || p.length !== ACK_SIZE) return null;
  return {
    base: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0),
    bitmap: p.slice(4, 4 + BITMAP_BYTES),
    densityHint: p[ACK_SIZE - 1],
  };
}

/** bitmap의 i번째(base + i) 블록 수신 여부 */
export function bitAt(bitmap, i) {
  return (bitmap[i >> 3] >> (i & 7)) & 1;
}

export function setBit(bitmap, i) {
  bitmap[i >> 3] |= 1 << (i & 7);
}

// ───────── CANCEL ─────────

export function encodeCancel(reason) {
  return new Uint8Array([reason & 0xff]);
}

/** @returns {number | null} */
export function decodeCancel(p) {
  return p instanceof Uint8Array && p.length === 1 ? p[0] : null;
}

// ───────── INFO 평문 (암호화되어 전달) ─────────
// ver(1) ‖ fileCount(2) ‖ plainSize(4) ‖ cipherSize(4) ‖ blockSize(2) ‖ totalBlocks(4)
//   ‖ sha256(zip)(32) ‖ payloadIv(12) ‖ nameLen(1) ‖ name(UTF-8, ≤ INFO_NAME_MAX)

export const INFO_VERSION = 1;
export const INFO_NAME_MAX = 180; // 60자 × 최대 3바이트
export const TRANSFER_MAX = 64 * 1024 * 1024; // 암호문 상한 (앱 50MB를 압축한 zip이면 충분)
export const BLOCK_MIN = 16;
export const BLOCK_MAX = 1024;
const INFO_FIXED = 1 + 2 + 4 + 4 + 2 + 4 + 32 + IV_SIZE + 1;

/**
 * @param {{fileCount: number, plainSize: number, cipherSize: number, blockSize: number, totalBlocks: number,
 *          sha256: Uint8Array, payloadIv: Uint8Array, name: string}} i
 */
export function encodeInfo(i) {
  const name = truncateUtf8(i.name, INFO_NAME_MAX);
  const p = new Uint8Array(INFO_FIXED + name.length);
  const v = new DataView(p.buffer);
  p[0] = INFO_VERSION;
  v.setUint16(1, i.fileCount);
  v.setUint32(3, i.plainSize);
  v.setUint32(7, i.cipherSize);
  v.setUint16(11, i.blockSize);
  v.setUint32(13, i.totalBlocks);
  p.set(i.sha256, 17);
  p.set(i.payloadIv, 49);
  p[61] = name.length;
  p.set(name, INFO_FIXED);
  return p;
}

/** 필드 사이의 관계까지 검사한다 (블록 수 = ceil(암호문 / 블록), 암호문 = 평문 + 태그) */
export function decodeInfo(p) {
  if (!(p instanceof Uint8Array) || p.length < INFO_FIXED || p[0] !== INFO_VERSION) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const nameLen = p[61];
  if (nameLen > INFO_NAME_MAX || p.length !== INFO_FIXED + nameLen) return null;
  const info = {
    fileCount: v.getUint16(1),
    plainSize: v.getUint32(3),
    cipherSize: v.getUint32(7),
    blockSize: v.getUint16(11),
    totalBlocks: v.getUint32(13),
    sha256: p.slice(17, 49),
    payloadIv: p.slice(49, 61),
  };
  // 설치 상한(C-4)을 넘는 앱은 버퍼를 잡거나 전송하기 전에 거부한다. 정상 송신자의 앱은 같은 상한으로 설치된 것이다
  if (info.fileCount < 1 || info.fileCount > LIMITS.fileCount || info.plainSize < 1) return null;
  if (info.cipherSize !== info.plainSize + TAG_SIZE || info.cipherSize > TRANSFER_MAX) return null;
  if (info.blockSize < BLOCK_MIN || info.blockSize > BLOCK_MAX) return null;
  if (info.totalBlocks !== Math.ceil(info.cipherSize / info.blockSize)) return null;
  try {
    info.name = td.decode(p.subarray(INFO_FIXED));
  } catch {
    return null;
  }
  return info;
}
