// 단방향 전송 프레임 v2 (TASK T7.3, TRANSPORT §5)
//   magic(1)=0x54 | ver(1)=2 | sid(4) | type(1) | payload(N) | CRC32(4)
//   META: fmt(1) ‖ fileCount(2) ‖ zipSize(4) ‖ symbolSize(2) ‖ k(4) ‖ sha256(zip)(32) ‖ nameLen(1) ‖ name(UTF-8)
//   SYM:  firstId(4) ‖ count(1) ‖ count × symbolSize 바이트 (id firstId, firstId+1, … 의 LT 심볼)
// 다중 바이트 정수는 big-endian. 파서는 예외를 던지지 않고 null을 돌려주며, 모든 길이를 상한과 비교한다.
// 암호화하지 않는다(TASK D7.1). 무결성은 프레임 CRC32(전송 오류)와 META의 SHA-256(본문)으로 본다.

import { crc32 } from './crc32.js';
import { LIMITS } from '../installer/validate.js';

export const MAGIC = 0x54;
export const VERSION = 2;
export const LEGACY_VERSION = 1; // 맞대기(1.x) 프레임
export const HEADER_SIZE = 7;
export const TRAILER_SIZE = 4;
export const OVERHEAD = HEADER_SIZE + TRAILER_SIZE;
export const MAX_FRAME_SIZE = 4096;

export const TYPE = Object.freeze({ META: 1, SYM: 2 });

export const META_FORMAT = 1;
export const NAME_MAX = 180; // 60자 × 최대 3바이트
// 받는 앱 상한: 앱 50MB(C-3) + zip 여유 2MB. zip이 늘어나는 최악의 양은 약 1.65MB다
//   (파일 헤더 1000개 × (76 + 경로 2번 × 255자 × UTF-8 3B), deflate stored 블록 약 38KB).
//   validate.js LIMITS를 올리면 다시 계산한다
export const TRANSFER_MAX = 52 * 1024 * 1024;
export const SYMBOL_MIN = 64; // k 상한 = 52MB / 64B ≈ 85만 블록 (복호기 메모리, 보안 검토 T7.8)
export const SYMBOL_MAX = 1024;
export const SYM_HEADER = 5;
export const MAX_SYMBOLS_PER_FRAME = 64;
const META_FIXED = 1 + 2 + 4 + 2 + 4 + 32 + 1;

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

/** 32비트 세션 ID (0 제외). LT 시드로도 쓴다 */
export function randomSid() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] === 0);
  return a[0];
}

/**
 * @param {{sid: number, type: number, payload: Uint8Array}} frame
 * @returns {Uint8Array}
 */
export function encodeFrame({ sid, type, payload }) {
  const size = OVERHEAD + payload.length;
  if (size > MAX_FRAME_SIZE) throw new RangeError('frame too large');
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  buf[0] = MAGIC;
  buf[1] = VERSION;
  view.setUint32(2, sid >>> 0);
  buf[6] = type;
  buf.set(payload, HEADER_SIZE);
  view.setUint32(size - TRAILER_SIZE, crc32(buf, 0, size - TRAILER_SIZE));
  return buf;
}

/**
 * 손상·미지원 프레임은 null. CRC가 맞는 1.x 프레임은 {legacy: true}를 돌려준다(업데이트 안내용).
 * @param {Uint8Array} buf
 * @returns {{sid: number, type: number, payload: Uint8Array} | {legacy: true} | null}
 */
export function decodeFrame(buf) {
  if (!(buf instanceof Uint8Array)) return null;
  if (buf.length < OVERHEAD || buf.length > MAX_FRAME_SIZE || buf[0] !== MAGIC) return null;
  if (buf[1] !== VERSION && buf[1] !== LEGACY_VERSION) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(buf.length - TRAILER_SIZE) !== crc32(buf, 0, buf.length - TRAILER_SIZE)) return null;
  if (buf[1] === LEGACY_VERSION) return { legacy: true };
  const type = buf[6];
  if (type !== TYPE.META && type !== TYPE.SYM) return null;
  return { sid: view.getUint32(2), type, payload: buf.subarray(HEADER_SIZE, buf.length - TRAILER_SIZE) };
}

// ───────── META ─────────

/** @param {{fileCount: number, zipSize: number, symbolSize: number, k: number, sha256: Uint8Array, name: string}} m */
export function encodeMeta(m) {
  if (m.sha256.length !== 32) throw new RangeError('sha256');
  const name = truncateUtf8(m.name, NAME_MAX);
  const p = new Uint8Array(META_FIXED + name.length);
  const v = new DataView(p.buffer);
  p[0] = META_FORMAT;
  v.setUint16(1, m.fileCount);
  v.setUint32(3, m.zipSize);
  v.setUint16(7, m.symbolSize);
  v.setUint32(9, m.k);
  p.set(m.sha256, 13);
  p[45] = name.length;
  p.set(name, META_FIXED);
  return p;
}

/** 필드 사이의 관계까지 검사한다 (k = ceil(zipSize / symbolSize)). 설치 상한(C-4)을 넘는 앱은 버퍼를 잡기 전에 거부한다 */
export function decodeMeta(p) {
  if (!(p instanceof Uint8Array) || p.length < META_FIXED || p[0] !== META_FORMAT) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const nameLen = p[45];
  if (nameLen > NAME_MAX || p.length !== META_FIXED + nameLen) return null;
  const meta = {
    fileCount: v.getUint16(1),
    zipSize: v.getUint32(3),
    symbolSize: v.getUint16(7),
    k: v.getUint32(9),
    sha256: p.slice(13, 45),
  };
  if (meta.fileCount < 1 || meta.fileCount > LIMITS.fileCount) return null;
  if (meta.zipSize < 1 || meta.zipSize > TRANSFER_MAX) return null;
  if (meta.symbolSize < SYMBOL_MIN || meta.symbolSize > SYMBOL_MAX) return null;
  if (meta.k !== Math.ceil(meta.zipSize / meta.symbolSize)) return null;
  try {
    meta.name = td.decode(p.subarray(META_FIXED));
  } catch {
    return null;
  }
  return meta;
}

// ───────── SYM ─────────

/** @param {{firstId: number, symbols: Uint8Array[]}} s */
export function encodeSym({ firstId, symbols }) {
  const count = symbols.length;
  if (count < 1 || count > MAX_SYMBOLS_PER_FRAME) throw new RangeError('sym count');
  const size = symbols[0].length;
  const p = new Uint8Array(SYM_HEADER + count * size);
  new DataView(p.buffer).setUint32(0, firstId >>> 0);
  p[4] = count;
  symbols.forEach((s, i) => {
    if (s.length !== size) throw new RangeError('sym size');
    p.set(s, SYM_HEADER + i * size);
  });
  return p;
}

/**
 * @param {Uint8Array} p
 * @param {number} symbolSize META로 알게 된 값
 * @returns {{firstId: number, count: number, symbol(i: number): Uint8Array} | null}
 */
export function decodeSym(p, symbolSize) {
  if (!(p instanceof Uint8Array) || p.length < SYM_HEADER + 1) return null;
  const count = p[4];
  if (count < 1 || count > MAX_SYMBOLS_PER_FRAME || p.length !== SYM_HEADER + count * symbolSize) return null;
  const firstId = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
  if (firstId + count - 1 > 0xffffffff) return null;
  return {
    firstId,
    count,
    symbol: (i) => p.subarray(SYM_HEADER + i * symbolSize, SYM_HEADER + (i + 1) * symbolSize),
  };
}

/** 프레임 바이트 상한 → 실을 수 있는 심볼 수 */
export function symbolsPerFrame(frameBytes, symbolSize) {
  return Math.max(1, Math.min(MAX_SYMBOLS_PER_FRAME, Math.floor((frameBytes - OVERHEAD - SYM_HEADER) / symbolSize)));
}
