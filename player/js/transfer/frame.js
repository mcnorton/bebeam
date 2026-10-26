// 광학 전송 프레임 (ARCHITECTURE §5.3)
//   magic(1) | ver(1) | senderSid(4) | type(1) | payload(N) | CRC32(4)
// 다중 바이트 정수는 big-endian.

import { crc32 } from './crc32.js';

export const MAGIC = 0x54;
export const VERSION = 1;
export const HEADER_SIZE = 7;
export const TRAILER_SIZE = 4;
export const OVERHEAD = HEADER_SIZE + TRAILER_SIZE;
export const MAX_FRAME_SIZE = 4096;

export const TYPE = Object.freeze({
  HELLO: 1,
  INFO: 2,
  ACCEPT: 3,
  DATA: 4,
  ACK: 5,
  DONE: 6,
  RESULT: 7,
  CANCEL: 8,
});

const KNOWN_TYPES = new Set(Object.values(TYPE));

/**
 * @param {{sid: number, type: number, payload?: Uint8Array}} frame
 * @returns {Uint8Array}
 */
export function encodeFrame({ sid, type, payload = new Uint8Array(0) }) {
  const size = OVERHEAD + payload.length;
  if (size > MAX_FRAME_SIZE) throw new Error('frame too large');
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
 * 손상·미지원 프레임은 null을 반환한다 (예외를 던지지 않는다).
 * @param {Uint8Array} buf
 * @returns {{sid: number, type: number, payload: Uint8Array} | null}
 */
export function decodeFrame(buf) {
  if (!(buf instanceof Uint8Array)) return null;
  if (buf.length < OVERHEAD || buf.length > MAX_FRAME_SIZE) return null;
  if (buf[0] !== MAGIC || buf[1] !== VERSION) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(buf.length - TRAILER_SIZE) !== crc32(buf, 0, buf.length - TRAILER_SIZE)) return null;
  const type = buf[6];
  if (!KNOWN_TYPES.has(type)) return null;
  return {
    sid: view.getUint32(2),
    type,
    payload: buf.subarray(HEADER_SIZE, buf.length - TRAILER_SIZE),
  };
}

/** 32비트 세션 ID (0은 "모름"을 뜻하므로 제외) */
export function randomSid() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] === 0);
  return a[0];
}
