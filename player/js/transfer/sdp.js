// WebRTC 내부망 전송(M5)의 DataChannel 전용 SDP를 QR 한 장에 들어가게 줄이고(compact) 다시 만든다(expand).
// T5.2 PoC(poc/webrtc/)에서 실기기로 확인했다: 75–101B, QR v5–v6.
// 브라우저 SDP에서 연결에 꼭 필요한 값만 남긴다: ICE ufrag·pwd, DTLS fingerprint·setup, mid, host 후보.
// STUN을 쓰지 않으므로(D5.1) host 후보만, 그중 내부망 주소(사설 IPv4, 링크 로컬, ULA, mDNS)만 담는다.
// DOM 비의존이라 Node에서 테스트한다.
//
// 형식 v1 (바이트):
//   ver(1) ‖ kind(1: 1 offer, 2 answer) ‖ setup(1: 0 actpass, 1 active, 2 passive)
//   ‖ midLen(1) mid ‖ ufragLen(1) ufrag ‖ pwdLen(1) pwd ‖ fingerprint sha-256(32)
//   ‖ candCount(1) ‖ 후보마다 addrType(1: 4 IPv4 4B, 6 IPv6 16B, 0x6d mDNS UUID 16B) ‖ 주소 ‖ port(2)

export const VERSION = 1;
export const KIND = Object.freeze({ offer: 1, answer: 2 });
const SETUPS = ['actpass', 'active', 'passive'];
const ADDR = Object.freeze({ IPV4: 4, IPV6: 6, MDNS: 0x6d });

export const LIMITS = Object.freeze({ mid: 16, ufragMin: 4, ufrag: 32, pwdMin: 22, pwd: 64, candidates: 8 });
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
const MID_CHARS = /^[A-Za-z0-9_-]+$/;
const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

// ───────── 주소 ─────────

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? Uint8Array.from(b) : null;
}

function parseIPv6(s) {
  if (!/^[0-9a-f:]+$/i.test(s) || s.length > 39) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function formatAddr(type, b) {
  if (type === ADDR.IPV4) return [...b].join('.');
  if (type === ADDR.IPV6) {
    const g = [];
    for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
    return g.join(':');
  }
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
}

/** 후보 주소 문자열 → {type, bytes} (지원하지 않으면 null) */
export function encodeAddr(addr) {
  const m = UUID.exec(addr);
  if (m) return { type: ADDR.MDNS, bytes: Uint8Array.from(m.slice(1).join('').match(/../g), (x) => parseInt(x, 16)) };
  const v4 = parseIPv4(addr);
  if (v4) return { type: ADDR.IPV4, bytes: v4 };
  const v6 = parseIPv6(addr);
  if (v6) return { type: ADDR.IPV6, bytes: v6 };
  return null;
}

/** 측정 기록용 분류 (주소 자체는 기록하지 않는다) */
export function addrKind(addr) {
  if (UUID.test(addr)) return 'mdns';
  const v4 = parseIPv4(addr);
  if (v4) {
    const [a, b] = v4;
    if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)) return 'ipv4-private';
    if (a === 169 && b === 254) return 'ipv4-linklocal';
    if (a === 100 && b >= 64 && b < 128) return 'ipv4-cgnat';
    return 'ipv4-public';
  }
  const v6 = parseIPv6(addr);
  if (v6) {
    if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return 'ipv6-linklocal';
    if ((v6[0] & 0xfe) === 0xfc) return 'ipv6-ula'; // fc00::/7
    return 'ipv6';
  }
  return 'other';
}

/** 같은 내부망 주소만 주고받는다 (D5.1). 공인 IPv4·전역 IPv6는 보내지도 받지도 않는다 */
const LOCAL_KINDS = new Set(['mdns', 'ipv4-private', 'ipv4-linklocal', 'ipv6-linklocal', 'ipv6-ula']);
export function isLocalAddr(addr) {
  return LOCAL_KINDS.has(addrKind(addr));
}

// ───────── SDP 읽기 ─────────

/**
 * 브라우저 SDP에서 필요한 값을 꺼낸다. DataChannel 하나(m=application)만 있다고 본다.
 * @returns {{setup: string, mid: string, ufrag: string, pwd: string, fingerprint: Uint8Array,
 *   candidates: {addr: string, port: number}[], skipped: {reason: string, line: string}[]}}
 */
export function readSdp(sdp) {
  const lines = String(sdp).split(/\r?\n/);
  const get = (prefix) => {
    const l = lines.find((x) => x.startsWith(prefix));
    return l ? l.slice(prefix.length).trim() : null;
  };
  const fp = get('a=fingerprint:');
  if (!fp) throw new Error('fingerprint 없음');
  const [algo, value] = fp.split(/\s+/);
  if (algo.toLowerCase() !== 'sha-256') throw new Error(`지원하지 않는 fingerprint: ${algo}`);
  const fpBytes = value.split(':').map((x) => parseInt(x, 16));
  if (fpBytes.length !== 32 || fpBytes.some((x) => !(x >= 0 && x <= 255))) throw new Error('fingerprint 형식 오류');

  const candidates = [];
  const skipped = [];
  for (const l of lines) {
    if (!l.startsWith('a=candidate:')) continue;
    // candidate:foundation component transport priority address port typ type ...
    const t = l.slice('a=candidate:'.length).trim().split(/\s+/);
    const [, component, transport, , addr, port, typ, type] = t;
    if (typ !== 'typ' || component !== '1') { skipped.push({ reason: 'format', line: l }); continue; }
    if (transport.toLowerCase() !== 'udp') { skipped.push({ reason: transport.toLowerCase(), line: l }); continue; }
    if (type !== 'host') { skipped.push({ reason: type, line: l }); continue; }
    if (!encodeAddr(addr)) { skipped.push({ reason: 'addr', line: l }); continue; }
    // 내부망 밖 주소(공인 IPv4, 전역 IPv6)는 상대에게 알리지 않는다
    if (!isLocalAddr(addr)) { skipped.push({ reason: 'scope', line: l }); continue; }
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { skipped.push({ reason: 'port', line: l }); continue; }
    if (candidates.some((c) => c.addr === addr && c.port === p)) continue;
    if (candidates.length >= LIMITS.candidates) { skipped.push({ reason: 'limit', line: l }); continue; }
    candidates.push({ addr, port: p });
  }

  return {
    setup: get('a=setup:') ?? 'actpass',
    mid: get('a=mid:') ?? '0',
    ufrag: get('a=ice-ufrag:') ?? '',
    pwd: get('a=ice-pwd:') ?? '',
    fingerprint: Uint8Array.from(fpBytes),
    candidates,
    skipped,
  };
}

// ───────── 직렬화 ─────────

const te = new TextEncoder();
const td = new TextDecoder();

function checkFields(f) {
  if (!SETUPS.includes(f.setup)) throw new Error(`setup 오류: ${f.setup}`);
  if (!MID_CHARS.test(f.mid) || f.mid.length > LIMITS.mid) throw new Error('mid 오류');
  if (!ICE_CHARS.test(f.ufrag) || f.ufrag.length < LIMITS.ufragMin || f.ufrag.length > LIMITS.ufrag) throw new Error('ice-ufrag 오류');
  if (!ICE_CHARS.test(f.pwd) || f.pwd.length < LIMITS.pwdMin || f.pwd.length > LIMITS.pwd) throw new Error('ice-pwd 오류');
}

/**
 * @param {string} sdp  pc.localDescription.sdp (후보 수집 뒤)
 * @param {'offer'|'answer'} kind
 * @returns {Uint8Array}
 */
export function compact(sdp, kind) {
  const f = readSdp(sdp);
  checkFields(f);
  const parts = [
    Uint8Array.of(VERSION, KIND[kind], SETUPS.indexOf(f.setup)),
    Uint8Array.of(f.mid.length), te.encode(f.mid),
    Uint8Array.of(f.ufrag.length), te.encode(f.ufrag),
    Uint8Array.of(f.pwd.length), te.encode(f.pwd),
    f.fingerprint,
    Uint8Array.of(f.candidates.length),
  ];
  for (const c of f.candidates) {
    const a = encodeAddr(c.addr);
    parts.push(Uint8Array.of(a.type), a.bytes, Uint8Array.of(c.port >> 8, c.port & 0xff));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * 방어적으로 읽는다. 형식이 틀리면 null.
 * @returns {{kind: 'offer'|'answer', setup: string, mid: string, ufrag: string, pwd: string,
 *   fingerprint: Uint8Array, candidates: {addr: string, port: number}[]} | null}
 */
export function parseCompact(bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let o = 0;
    const take = (n) => {
      if (o + n > b.length) throw new Error('short');
      const s = b.subarray(o, o + n);
      o += n;
      return s;
    };
    const u8 = () => take(1)[0];
    const str = () => td.decode(take(u8()));
    if (u8() !== VERSION) return null;
    const kindByte = u8();
    const kind = kindByte === KIND.offer ? 'offer' : kindByte === KIND.answer ? 'answer' : null;
    const setup = SETUPS[u8()];
    if (!kind || !setup) return null;
    const f = { kind, setup, mid: str(), ufrag: str(), pwd: str(), fingerprint: take(32).slice() };
    checkFields(f);
    const n = u8();
    if (n > LIMITS.candidates) return null;
    f.candidates = [];
    for (let i = 0; i < n; i++) {
      const type = u8();
      const len = type === ADDR.IPV4 ? 4 : type === ADDR.IPV6 || type === ADDR.MDNS ? 16 : 0;
      if (!len) return null;
      const addr = formatAddr(type, take(len));
      const p = take(2);
      const port = (p[0] << 8) | p[1];
      if (port === 0) return null;
      // 상대가 내부망 밖 주소를 넣었으면 받지 않는다 (짝 상대가 경로를 인터넷 서버로 돌리지 못하게)
      if (!isLocalAddr(addr)) return null;
      f.candidates.push({ addr, port });
    }
    if (o !== b.length) return null;
    return f;
  } catch {
    return null;
  }
}

/** parseCompact 결과 → setRemoteDescription에 넣을 SDP */
export function expand(f) {
  const fp = [...f.fingerprint].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const L = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${f.mid}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ];
  f.candidates.forEach((c, i) => {
    // host 후보 우선순위: type pref 126, local pref는 순서대로 낮춘다 (RFC 8445 §5.1.2.1)
    const priority = 126 * 2 ** 24 + (65535 - i) * 2 ** 8 + 255;
    L.push(`a=candidate:${i + 1} 1 udp ${priority} ${c.addr} ${c.port} typ host`);
  });
  L.push(
    'a=end-of-candidates',
    `a=ice-ufrag:${f.ufrag}`,
    `a=ice-pwd:${f.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${f.setup}`,
    `a=mid:${f.mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  );
  return L.join('\r\n') + '\r\n';
}
