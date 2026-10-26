// Base45 (RFC 9285). 문자 집합이 QR alphanumeric 모드와 같아 QR에 효율적으로 실린다.

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const LOOKUP = new Map([...CHARSET].map((c, i) => [c, i]));

/** @param {Uint8Array} bytes */
export function encode(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i] * 256 + bytes[i + 1];
    const c = n % 45; n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out += CHARSET[c] + CHARSET[d] + CHARSET[e];
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1];
    out += CHARSET[n % 45] + CHARSET[Math.floor(n / 45)];
  }
  return out;
}

/**
 * @param {string} str
 * @returns {Uint8Array} 잘못된 입력이면 throw
 */
export function decode(str) {
  if (str.length % 3 === 1) throw new Error('base45: invalid length');
  const out = new Uint8Array(Math.floor(str.length / 3) * 2 + (str.length % 3 === 2 ? 1 : 0));
  let o = 0;
  for (let i = 0; i < str.length; i += 3) {
    const c = val(str[i]);
    const d = val(str[i + 1]);
    if (i + 2 < str.length) {
      const n = c + d * 45 + val(str[i + 2]) * 2025;
      if (n > 0xffff) throw new Error('base45: value out of range');
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = c + d * 45;
      if (n > 0xff) throw new Error('base45: value out of range');
      out[o++] = n;
    }
  }
  return out;
}

function val(ch) {
  const v = LOOKUP.get(ch);
  if (v === undefined) throw new Error('base45: invalid character');
  return v;
}

/** base45 문자 수 `chars`에 담을 수 있는 최대 바이트 수 */
export function maxBytesForChars(chars) {
  return Math.floor(chars / 3) * 2 + (chars % 3 === 2 ? 1 : 0);
}
