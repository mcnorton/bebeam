// 단방향 방송 전송 (TASK T7.4, TRANSPORT §5)
//   송신: zip → LT 심볼을 끝없이 만들어 QR 프레임에 싣는다. 8장마다 META 1장. 받는 쪽 상태는 모른다.
//   수신: 처음 본 META의 sid에 고정하고, 심볼을 모아 복원 → SHA-256 비교. 여러 명이 같은 화면을 동시에 받을 수 있다.
// DOM 없음. 시계(now)는 주입한다. 화면 루프는 nextFrame()을, 카메라 루프는 onFrame()을 부른다.

import { LtEncoder, LtDecoder } from './fountain.js';
import {
  TYPE, encodeFrame, decodeFrame, encodeMeta, decodeMeta, encodeSym, decodeSym, symbolsPerFrame, randomSid, TRANSFER_MAX,
} from './beam.js';

/** QR 속도 단계. bytes = base45 전 프레임 상한(alphanumeric 용량 × 2/3). 잠정값, 실기기로 조정 (R4 §2.1) */
export const SPEED = Object.freeze({
  slow: Object.freeze({ version: 15, ecc: 'L', bytes: 505, fps: 8 }),
  normal: Object.freeze({ version: 25, ecc: 'L', bytes: 1235, fps: 10 }),
  fast: Object.freeze({ version: 30, ecc: 'L', bytes: 1680, fps: 12 }),
});
export const DEFAULT_SPEED = 'normal';
export const DEFAULT_SYMBOL = 128;
export const META_EVERY = 8; // 프레임 8장마다 META 1장 (늦게 찍기 시작한 수신자도 1초 안에 본다)

export const STATE = Object.freeze({
  SCANNING: 'scanning', // 아직 이 전송의 META를 못 봄
  RECEIVING: 'receiving',
  STALLED: 'stalled', // 받던 중 STALL_MS 동안 프레임이 없음 (틀에서 벗어남)
  VERIFYING: 'verifying',
  DONE: 'done',
  FAILED: 'failed',
});

export const STALL_MS = 3_000;
export const IDLE_MS = 180_000; // 이 시간 동안 프레임이 없으면 대기를 끝낸다 (받는 화면이 열린 채 남지 않게)
const RATE_WINDOW_MS = 3_000;
const PRELOCK_FRAMES = 128; // META 전에 받아 둘 SYM 프레임 수
/** 받은 고유 심볼이 k × 이 값 + MAX_EXTRA_SYMBOLS를 넘어도 안 풀리면 그만둔다 (끝없는 위조 심볼로 메모리를 채우지 못하게) */
export const MAX_SYMBOL_RATIO = 2;
const MAX_EXTRA_SYMBOLS = 256;
/** 진행률·남은 시간 계산에 쓰는 예상 오버헤드 (R4 시뮬레이션 1.03–1.10×) */
export const EXPECTED_OVERHEAD = 1.06;

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export class FountainSender {
  #encoder;
  #metaFrame = null;
  #nextId = 0;
  #frameNo = 0;
  #speed;

  /**
   * @param {{zip: Uint8Array, name: string, fileCount: number, speed?: keyof SPEED, sid?: number, symbolSize?: number}} o
   */
  constructor({ zip, name, fileCount, speed = DEFAULT_SPEED, sid = randomSid(), symbolSize = DEFAULT_SYMBOL }) {
    if (zip.length < 1 || zip.length > TRANSFER_MAX) throw new RangeError('zip size');
    this.sid = sid >>> 0;
    this.zip = zip;
    this.name = name;
    this.fileCount = fileCount;
    this.symbolSize = symbolSize;
    this.#encoder = new LtEncoder(zip, { size: symbolSize, seed: this.sid });
    this.k = this.#encoder.k;
    this.setSpeed(speed);
    this.stats = { frames: 0, symbols: 0 };
  }

  async init() {
    const payload = encodeMeta({
      fileCount: this.fileCount, zipSize: this.zip.length, symbolSize: this.symbolSize, k: this.k,
      sha256: await sha256(this.zip), name: this.name,
    });
    this.#metaFrame = encodeFrame({ sid: this.sid, type: TYPE.META, payload });
    return this;
  }

  get speed() {
    return this.#speed;
  }

  get fps() {
    return SPEED[this.#speed].fps;
  }

  /** 전송 중에 바꿔도 된다: 프레임당 심볼 수만 달라지고 심볼 id는 이어진다 */
  setSpeed(speed) {
    if (!SPEED[speed]) throw new RangeError('speed');
    this.#speed = speed;
  }

  /** 손실이 없을 때 한 바퀴(심볼 k개)를 몇 번 보냈는지 (화면 안내용) */
  get passes() {
    return this.stats.symbols / this.k;
  }

  /**
   * version: 속도 단계의 QR 버전. META처럼 짧은 프레임도 같은 버전으로 그려 화면 밀도를 일정하게 한다
   * @returns {{bytes: Uint8Array, ecc: 'L'|'M', version: number}}
   */
  nextFrame() {
    if (!this.#metaFrame) throw new Error('init() first');
    const s = SPEED[this.#speed];
    this.stats.frames++;
    if (this.#frameNo++ % META_EVERY === 0) return { bytes: this.#metaFrame, ecc: s.ecc, version: s.version };
    const n = symbolsPerFrame(s.bytes, this.symbolSize);
    const firstId = this.#nextId;
    const symbols = [];
    for (let i = 0; i < n; i++) symbols.push(this.#encoder.symbol((firstId + i) >>> 0));
    this.#nextId = (firstId + n) >>> 0;
    this.stats.symbols += n;
    return { bytes: encodeFrame({ sid: this.sid, type: TYPE.SYM, payload: encodeSym({ firstId, symbols }) }), ecc: s.ecc, version: s.version };
  }
}

export class FountainReceiver {
  #now;
  #onChange;
  #state;
  #decoder = null;
  #prelock = [];
  #samples = [];
  #verifying = null;
  #startedAt;
  #lastHeardAt = 0;
  #final = null; // 복원 버퍼를 놓은 뒤의 received·decoded

  /** @param {{now?: () => number, onChange?: () => void}} [o] */
  constructor({ now = () => Date.now(), onChange = () => {} } = {}) {
    this.#now = now;
    this.#onChange = onChange;
    this.restart();
  }

  /** 처음 상태로 (해시가 틀렸을 때 [다시 받기]). 송신자는 계속 돌고 있으므로 버퍼만 비운다 */
  restart() {
    this.#state = STATE.SCANNING;
    this.#decoder = null;
    this.#prelock = [];
    this.#samples = [];
    this.#verifying = null;
    this.#startedAt = this.#now();
    this.#lastHeardAt = 0;
    this.#final = null;
    this.sid = 0;
    this.meta = null;
    this.zip = null;
    this.failReason = null;
    this.legacySeen = false; // 1.x 송신자를 봤다 → 업데이트 안내
    this.stats = { frames: 0, valid: 0, foreign: 0, decodeTries: 0, decodeHits: 0 };
  }

  get state() {
    const s = this.#state;
    if (s === STATE.RECEIVING || s === STATE.SCANNING) {
      const t = this.#now();
      if (t - (this.#lastHeardAt || this.#startedAt) > IDLE_MS) {
        this.#fail('idle');
        return this.#state;
      }
      if (s === STATE.RECEIVING && t - this.#lastHeardAt > STALL_MS) return STATE.STALLED;
    }
    return s;
  }

  get finished() {
    return this.#state === STATE.DONE || this.#state === STATE.FAILED;
  }

  get k() {
    return this.meta?.k ?? 0;
  }

  get received() {
    return this.#decoder?.received ?? this.#final?.received ?? 0;
  }

  get decoded() {
    return this.#decoder?.decoded ?? this.#final?.decoded ?? 0;
  }

  /** 0–1. 복원이 끝나기 전에는 99%를 넘지 않는다 */
  get progress() {
    if (this.#state === STATE.DONE || this.#state === STATE.VERIFYING) return 1;
    if (!this.#decoder) return 0;
    const k = this.meta.k;
    return Math.min(0.99, Math.max(this.decoded / k, this.received / (k * EXPECTED_OVERHEAD)));
  }

  /** 최근 3초 동안 새로 받은 심볼 바이트/초 */
  get bytesPerSecond() {
    const s = this.#samples;
    if (s.length < 2) return 0;
    const [t0, r0] = s[0];
    const [t1, r1] = s[s.length - 1];
    return t1 > t0 ? ((r1 - r0) * this.meta.symbolSize * 1000) / (t1 - t0) : 0;
  }

  /** 남은 시간(초). 모르면 null */
  get etaSeconds() {
    const bps = this.bytesPerSecond;
    if (!this.#decoder || bps <= 0) return null;
    const left = Math.max(0, this.meta.k * EXPECTED_OVERHEAD - this.received) * this.meta.symbolSize;
    return left / bps;
  }

  /** 카메라 루프가 디코딩을 시도할 때마다 (인식률 표시용) */
  reportDecode(ok) {
    this.stats.decodeTries++;
    if (ok) this.stats.decodeHits++;
  }

  /** 시뮬레이터용: 진행 중인 검증을 기다린다 */
  idle() {
    return this.#verifying ?? Promise.resolve();
  }

  /** @param {Uint8Array} bytes base45를 푼 프레임 */
  onFrame(bytes) {
    if (this.finished || this.#state === STATE.VERIFYING) return;
    this.stats.frames++;
    const f = decodeFrame(bytes);
    if (!f) return;
    if (f.legacy) {
      if (!this.legacySeen) {
        this.legacySeen = true;
        this.#onChange();
      }
      return;
    }
    if (this.sid && f.sid !== this.sid) {
      this.stats.foreign++;
      return;
    }
    if (!this.sid) {
      if (f.type === TYPE.SYM) {
        this.#prelock.push({ sid: f.sid, payload: f.payload.slice() });
        if (this.#prelock.length > PRELOCK_FRAMES) this.#prelock.shift();
        return;
      }
      const meta = decodeMeta(f.payload);
      if (!meta) return;
      this.#lock(f.sid, meta);
    } else if (f.type === TYPE.SYM) {
      this.stats.valid++;
      this.#addSym(f.payload);
    }
    this.#lastHeardAt = this.#now();
    this.#afterAdd();
  }

  #lock(sid, meta) {
    this.sid = sid;
    this.meta = meta;
    this.#decoder = new LtDecoder({ k: meta.k, size: meta.symbolSize, seed: sid });
    this.#state = STATE.RECEIVING;
    this.stats.valid++;
    for (const p of this.#prelock) if (p.sid === sid) this.#addSym(p.payload);
    this.#prelock = [];
  }

  #addSym(payload) {
    const s = decodeSym(payload, this.meta.symbolSize);
    if (!s) return;
    for (let i = 0; i < s.count && !this.#decoder.done; i++) this.#decoder.add((s.firstId + i) >>> 0, s.symbol(i));
  }

  #afterAdd() {
    if (!this.#decoder.done && this.received > this.meta.k * MAX_SYMBOL_RATIO + MAX_EXTRA_SYMBOLS) {
      this.#decoder = null;
      this.#fail('too-many-symbols');
      return;
    }
    const t = this.#now();
    this.#samples.push([t, this.received]);
    while (this.#samples.length > 2 && t - this.#samples[0][0] > RATE_WINDOW_MS) this.#samples.shift();
    if (this.#decoder.done) {
      this.#state = STATE.VERIFYING;
      this.#verifying = this.#verify();
    }
    this.#onChange();
  }

  async #verify() {
    const zip = this.#decoder.result(this.meta.zipSize);
    const ok = sameBytes(await sha256(zip), this.meta.sha256);
    if (this.#state !== STATE.VERIFYING) return; // 기다리는 동안 restart()
    if (ok) {
      this.zip = zip;
      this.#state = STATE.DONE;
      this.#final = { received: this.received, decoded: this.decoded };
      this.#decoder = null; // 복원 버퍼를 놓는다 (zip만 남긴다)
      this.#onChange();
    } else this.#fail('hash-mismatch');
  }

  #fail(reason) {
    this.#state = STATE.FAILED;
    this.failReason = reason;
    this.#onChange();
  }
}
