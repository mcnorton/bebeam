// 전송 암호화 (ARCHITECTURE §5.5). WebCrypto만 쓴다 (브라우저, Node 22 모두 globalThis.crypto.subtle)
//   키 교환: ECDH P-256, 세션마다 새 키 쌍
//   키 유도: HKDF-SHA256(secret, salt = nonce(작은 sid) ‖ nonce(큰 sid),
//            info = "toybox/v1" ‖ pubkey(작은 sid) ‖ pubkey(큰 sid)) → AES-GCM-256 키 32B + SAS 4B
//   제어 메시지(INFO/ACCEPT/DONE/RESULT): 메시지마다 새 IV, AAD = type ‖ senderSid
//   파일 본문: zip 전체를 한 번에 암호화 (IV는 INFO에 담는다), AAD = "data" ‖ senderSid

import { IV_SIZE, PUBKEY_SIZE, NONCE_SIZE } from './payload.js';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const INFO_LABEL = te.encode('toybox/v1');
const DATA_LABEL = te.encode('data');

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** @returns {Promise<{privateKey: CryptoKey, publicKey: Uint8Array, nonce: Uint8Array}>} */
export async function createHandshake() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey, nonce: randomBytes(NONCE_SIZE) };
}

/**
 * 양쪽이 같은 키와 SAS를 얻는다. 상대 공개키가 곡선 위의 점이 아니면 reject.
 * @param {{privateKey: CryptoKey, publicKey: Uint8Array, nonce: Uint8Array, sid: number}} me
 * @param {{publicKey: Uint8Array, nonce: Uint8Array, sid: number}} peer
 * @returns {Promise<{key: CryptoKey, sas: string}>}
 */
export async function deriveSession(me, peer) {
  if (peer.publicKey.length !== PUBKEY_SIZE || peer.nonce.length !== NONCE_SIZE) throw new RangeError('peer handshake size');
  if (me.sid === peer.sid) throw new RangeError('same sid');
  const peerKey = await subtle.importKey('raw', peer.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: peerKey }, me.privateKey, 256);

  const [lo, hi] = (me.sid >>> 0) < (peer.sid >>> 0) ? [me, peer] : [peer, me];
  const hkdf = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: concat(lo.nonce, hi.nonce),
    info: concat(INFO_LABEL, lo.publicKey, hi.publicKey),
  }, hkdf, (32 + 4) * 8));

  const key = await subtle.importKey('raw', bits.subarray(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const n = new DataView(bits.buffer, bits.byteOffset + 32, 4).getUint32(0);
  return { key, sas: String(n % 10000).padStart(4, '0') };
}

/**
 * 제어 메시지 암호화.
 * @param {CryptoKey} key
 * @param {number} type 프레임 type
 * @param {number} senderSid
 * @param {Uint8Array} plaintext
 * @returns {Promise<{iv: Uint8Array, ct: Uint8Array}>}
 */
export async function seal(key, type, senderSid, plaintext) {
  const iv = randomBytes(IV_SIZE);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: concat([type], u32(senderSid)) }, key, plaintext));
  return { iv, ct };
}

/** 복호화. 태그·AAD가 맞지 않으면 null (예외를 던지지 않는다) */
export async function open(key, type, senderSid, { iv, ct }) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: concat([type], u32(senderSid)) }, key, ct));
  } catch {
    return null;
  }
}

/**
 * 파일 본문(zip) 전체 암호화. 결과 길이 = 평문 + 16(태그)
 * @returns {Promise<{iv: Uint8Array, ct: Uint8Array}>}
 */
export async function sealPayload(key, senderSid, zip) {
  const iv = randomBytes(IV_SIZE);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: concat(DATA_LABEL, u32(senderSid)) }, key, zip));
  return { iv, ct };
}

/** 조립한 암호문 복호화. GCM 태그로 전체 무결성과 인증을 확인한다. 실패하면 null */
export async function openPayload(key, senderSid, iv, ct) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: concat(DATA_LABEL, u32(senderSid)) }, key, ct));
  } catch {
    return null;
  }
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/** 상수 시간 비교 (해시 비교용) */
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
