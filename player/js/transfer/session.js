// QR 맞대기 전송 세션 (ARCHITECTURE §5.3–§5.5, SPEC F-05). DOM 비의존 순수 로직.
//   송신: ADVERTISING → PAIRED → OFFERING(INFO ⟳) → SENDING(DATA 순환) → VERIFYING → DONE | FAILED
//   수신: SCANNING → PAIRED → REVIEW(INFO 확인 → 화면이 자동 수락) → RECEIVING(ACCEPT ⟳ → ACK) → VERIFYING → DONE | FAILED
//
// 화면은 상태를 보여준다: nextFrame()은 지금 상태에 맞는 프레임을 돌려주고(⟳), 상대가 다음 단계로
// 넘어간 증거를 볼 때까지 같은 종류를 반복한다. 카메라가 읽은 프레임은 onFrame()으로 넣는다.
//
// 짝짓기: 확정 전에는 본 HELLO를 모두 후보로 기억한다(근처의 다른 세션이 섞여도 진짜 상대를 잃지 않도록).
//   확정 조건은 (1) 나를 지목한 HELLO, 또는 (수신자) (2) 후보와 유도한 키로 열리는 INFO.
//   인증되지 않은 DATA·ACK는 확정 증거로 쓰지 않는다 (다른 기기와 짝지어 보내는 프레임을 오인하지 않도록).

import { encodeFrame, decodeFrame, randomSid, TYPE, OVERHEAD } from './frame.js';
import { maxBytesForChars } from './base45.js';
import {
  ROLE, CANCEL_REASON, WINDOW_BLOCKS, BITMAP_BYTES, DATA_HEADER, MAX_BLOCKS_PER_FRAME,
  encodeHello, decodeHello, encodeSealed, decodeSealed, encodeData, decodeData, encodeAck, decodeAck,
  encodeCancel, decodeCancel, encodeInfo, decodeInfo, bitAt, setBit,
} from './payload.js';
import * as realCrypto from './crypto.js';

export { ROLE, CANCEL_REASON };

/** QR 밀도 단계 (ARCHITECTURE §5.2). chars는 alphanumeric 용량 */
export const DENSITY = Object.freeze([
  { id: 'D1', version: 10, ecc: 'M', chars: 311 },
  { id: 'D2', version: 15, ecc: 'L', chars: 758 },
  { id: 'D3', version: 20, ecc: 'L', chars: 1249 },
  { id: 'D4', version: 25, ecc: 'L', chars: 1853 },
]);

export const STATE = Object.freeze({
  ADVERTISING: 'advertising', // 송신: HELLO 표시
  SCANNING: 'scanning', // 수신: HELLO 표시
  PAIRED: 'paired', // 짝 확정, 키 유도 중
  OFFERING: 'offering', // 송신: INFO 표시, ACCEPT 대기
  REVIEW: 'review', // 수신: 앱 정보 확인, 수락 대기 (화면이 바로 accept()를 부른다)
  SENDING: 'sending',
  RECEIVING: 'receiving',
  VERIFYING: 'verifying',
  DONE: 'done',
  FAILED: 'failed',
});

export const STALL_MS = 5_000; // 이 시간 동안 상대 프레임이 없으면 "다시 맞대 주세요"
export const TIMEOUT_MS = 60_000; // 짝 확정 후 이 시간 동안 진전이 없으면 FAILED
export const RESULT_WAIT_MS = 10_000; // 수신자: 로컬 검증 후 RESULT를 이 시간까지 기다린다
export const DEFAULT_BLOCK = 64;
const MAX_CANDIDATES = 8;
const DENSITY_INTERVAL_MS = 2000;
const HINT_WINDOW_MS = 2000;

export function blocksPerFrame(density, blockSize) {
  const room = maxBytesForChars(density.chars) - OVERHEAD - DATA_HEADER;
  return Math.max(1, Math.min(MAX_BLOCKS_PER_FRAME, Math.floor(room / blockSize)));
}

export class TransferSession {
  /**
   * @param {object} o
   * @param {number} o.role ROLE.SENDER | ROLE.RECEIVER
   * @param {{zip: Uint8Array, name: string, fileCount: number}} [o.offer] 송신할 앱
   * @param {string} [o.deviceName]
   * @param {number} [o.blockSize]
   * @param {number} [o.density] DATA 시작 밀도 (DENSITY 인덱스)
   * @param {boolean} [o.autoDensity]
   * @param {() => number} [o.now]
   * @param {number} [o.sid]
   * @param {typeof realCrypto} [o.crypto]
   * @param {(s: TransferSession) => void} [o.onChange] 상태·진행이 바뀔 때
   */
  constructor({
    role, offer, deviceName = '', blockSize = DEFAULT_BLOCK, density = 1, autoDensity = true,
    now = () => Date.now(), sid = randomSid(), crypto = realCrypto, onChange = () => {},
  }) {
    if (role !== ROLE.SENDER && role !== ROLE.RECEIVER) throw new RangeError('role');
    if (role === ROLE.SENDER && !(offer?.zip instanceof Uint8Array)) throw new Error('sender needs offer.zip');
    this.role = role;
    this.sid = sid;
    this.deviceName = deviceName;
    this.now = now;
    this.c = crypto;
    this.onChange = onChange;
    this.state = role === ROLE.SENDER ? STATE.ADVERTISING : STATE.SCANNING;
    this.failReason = null;
    this.cancelReason = null;
    this.roleConflict = false;
    this.peerSid = 0;
    this.peerName = '';
    this.sas = null;
    /** @type {Map<number, {hello: object, session?: Promise<{key: CryptoKey, sas: string}>}>} */
    this.candidates = new Map();
    this.lastCandidate = 0;

    this.blockSize = blockSize;
    this.density = density;
    this.autoDensity = autoDensity;
    this.lastDensityChange = 0;
    this.peerHint = -1;
    this.decodeLog = [];

    const t = now();
    this.startedAt = t;
    this.pairedAt = 0;
    this.lastHeardAt = t;
    this.lastProgressAt = t;
    this.firstDataAt = 0;
    this.completedAt = 0;
    this.stats = { framesShown: 0, framesReceived: 0, badFrames: 0, foreignFrames: 0, duplicateBlocks: 0, densityHistory: [DENSITY[density].id] };

    this.offer = offer ?? null;
    this.info = null; // 수신자: 해독한 INFO
    this.zip = null; // 수신자: 검증을 마친 zip
    this.result = null; // 송신: 비교 결과 / 수신: RESULT로 받은 결과
    this.#work = Promise.resolve();
  }

  #work;
  #hs = null;
  #key = null;
  #infoFrame = null;
  #infoHash = null;
  #acceptFrame = null;
  #doneFrame = null;
  #resultFrame = null;
  #zipHash = null;
  #cipher = null;
  // 송신 ARQ
  #acked = null;
  #ackedCount = 0;
  #firstUnacked = 0;
  #cursor = 0;
  // 수신 버퍼
  #buf = null;
  #got = null;
  #gotCount = 0;
  #base = 0;
  #verifiedAt = 0;

  /** 키 쌍과 nonce를 만들고 (송신자는) zip 해시를 계산한다. 첫 nextFrame 전에 기다린다 */
  async init() {
    this.#hs = await this.c.createHandshake();
    if (this.role === ROLE.SENDER) this.#zipHash = await this.c.sha256(this.offer.zip);
    return this;
  }

  /** onFrame 등으로 시작된 비동기 처리가 모두 끝날 때까지 */
  idle() {
    return this.#work;
  }

  get totalBlocks() {
    const size = this.role === ROLE.SENDER ? this.#cipher?.ct.length : this.info?.cipherSize;
    return size ? Math.ceil(size / this.blockSize) : 0;
  }

  get progress() {
    const n = this.totalBlocks;
    if (!n) return 0;
    return (this.role === ROLE.SENDER ? this.#ackedCount : this.#gotCount) / n;
  }

  /** 짝 확정 후 STALL_MS 동안 상대 프레임이 없음 → "화면을 다시 맞대 주세요" */
  get stalled() {
    return this.pairedAt > 0 && !this.finished && this.now() - this.lastHeardAt > STALL_MS;
  }

  get finished() {
    return this.state === STATE.DONE || this.state === STATE.FAILED;
  }

  /** 수신자: 수락 (REVIEW에서만, SPEC F-05 규칙 3) */
  accept() {
    if (this.role !== ROLE.RECEIVER || this.state !== STATE.REVIEW) return Promise.resolve(false);
    this.#enqueue(async () => {
      if (this.state !== STATE.REVIEW) return;
      const s = await this.c.seal(this.#key, TYPE.ACCEPT, this.sid, this.#infoHash);
      this.#acceptFrame = encodeSealed(s);
      this.#buf = new Uint8Array(this.info.cipherSize);
      this.#got = new Uint8Array(this.totalBlocks);
      this.lastProgressAt = this.now();
      this.#setState(STATE.RECEIVING);
    });
    return this.#work.then(() => true);
  }

  /** [취소]/[거절]: CANCEL을 표시한다 (UI가 1초 뒤 화면을 닫는다) */
  cancel(reason = CANCEL_REASON.USER) {
    if (this.state === STATE.DONE) return;
    this.cancelReason = reason;
    this.#fail('local-cancel');
  }

  /** 카메라 디코딩 시도 결과 (densityHint 산출용) */
  reportDecode(ok) {
    const t = this.now();
    this.decodeLog.push([t, ok ? 1 : 0]);
    while (this.decodeLog.length && t - this.decodeLog[0][0] > HINT_WINDOW_MS) this.decodeLog.shift();
  }

  // ───────────── 수신 (카메라가 읽은 프레임) ─────────────

  /** @param {Uint8Array} bytes */
  onFrame(bytes) {
    const f = decodeFrame(bytes);
    if (!f) {
      this.stats.badFrames++;
      return this.#work;
    }
    if (f.sid === this.sid) return this.#work; // 자기 화면 반사
    if (this.pairedAt && f.sid !== this.peerSid) {
      this.stats.foreignFrames++;
      return this.#work;
    }
    this.stats.framesReceived++;
    return this.#enqueue(() => this.#handle(f));
  }

  #enqueue(fn) {
    this.#work = this.#work.then(fn).catch((err) => this.#fail(`internal:${err?.message ?? err}`));
    return this.#work;
  }

  async #handle(f) {
    if (this.finished && f.type !== TYPE.CANCEL) {
      // 수신자는 끝난 뒤에도 RESULT를 받을 수 있다
      if (!(this.role === ROLE.RECEIVER && f.type === TYPE.RESULT && this.state === STATE.DONE)) return;
    }
    if (this.pairedAt) this.lastHeardAt = this.now();

    switch (f.type) {
      case TYPE.HELLO: return this.#onHello(f);
      case TYPE.INFO: return this.role === ROLE.RECEIVER ? this.#onInfo(f) : undefined;
      case TYPE.CANCEL: return this.#onCancel(f);
      default:
    }
    if (!this.pairedAt) {
      this.stats.foreignFrames++;
      return;
    }
    switch (f.type) {
      case TYPE.ACCEPT: return this.role === ROLE.SENDER ? this.#onAccept(f) : undefined;
      case TYPE.DATA: return this.role === ROLE.RECEIVER ? this.#onData(f) : undefined;
      case TYPE.ACK: return this.role === ROLE.SENDER ? this.#onAck(f) : undefined;
      case TYPE.DONE: return this.role === ROLE.SENDER ? this.#onDone(f) : undefined;
      case TYPE.RESULT: return this.role === ROLE.RECEIVER ? this.#onResult(f) : undefined;
      default:
    }
  }

  async #onHello(f) {
    const h = decodeHello(f.payload);
    if (!h) {
      this.stats.badFrames++;
      return;
    }
    if (h.role === this.role) {
      this.roleConflict = true; // SPEC F-05 규칙 2
      this.onChange(this);
      return;
    }
    if (this.roleConflict) {
      this.roleConflict = false;
      this.onChange(this);
    }
    if (this.pairedAt) return;
    this.candidates.delete(f.sid);
    this.candidates.set(f.sid, { hello: h });
    if (this.candidates.size > MAX_CANDIDATES) this.candidates.delete(this.candidates.keys().next().value);
    this.lastCandidate = f.sid;
    if (h.peerSid === this.sid) await this.#commit(f.sid);
  }

  /** 후보의 세션 키 (후보별로 한 번만 유도) */
  #sessionFor(sid) {
    const c = this.candidates.get(sid);
    if (!c) return null;
    c.session ??= this.c.deriveSession(
      { ...this.#hs, sid: this.sid },
      { publicKey: c.hello.pubkey, nonce: c.hello.nonce, sid },
    );
    return c.session;
  }

  async #commit(sid, session) {
    if (this.pairedAt) return;
    const c = this.candidates.get(sid);
    let s;
    try {
      s = session ?? await this.#sessionFor(sid);
    } catch {
      this.candidates.delete(sid); // 잘못된 공개키
      return;
    }
    if (this.pairedAt) return;
    this.peerSid = sid;
    this.peerName = c.hello.deviceName;
    this.#key = s.key;
    this.sas = s.sas;
    this.candidates.clear();
    const t = this.now();
    this.pairedAt = t;
    this.lastHeardAt = t;
    this.lastProgressAt = t;
    this.#setState(STATE.PAIRED);
    if (this.role === ROLE.SENDER) await this.#prepareOffer();
  }

  async #prepareOffer() {
    this.#cipher = await this.c.sealPayload(this.#key, this.sid, this.offer.zip);
    const plain = encodeInfo({
      fileCount: this.offer.fileCount,
      plainSize: this.offer.zip.length,
      cipherSize: this.#cipher.ct.length,
      blockSize: this.blockSize,
      totalBlocks: Math.ceil(this.#cipher.ct.length / this.blockSize),
      sha256: this.#zipHash,
      payloadIv: this.#cipher.iv,
      name: this.offer.name,
    });
    this.#infoHash = await this.c.sha256(plain);
    this.#infoFrame = encodeSealed(await this.c.seal(this.#key, TYPE.INFO, this.sid, plain));
    this.#acked = new Uint8Array(this.totalBlocks);
    this.#setState(STATE.OFFERING);
  }

  async #onInfo(f) {
    if (this.info) return; // 이미 받았다 (⟳ 반복)
    const sealed = decodeSealed(f.payload);
    if (!sealed) {
      this.stats.badFrames++;
      return;
    }
    let session;
    if (this.pairedAt) {
      session = { key: this.#key, sas: this.sas };
    } else {
      // 후보와 유도한 키로 열리면 그 후보는 나와 짝지은 것이다 → 확정
      try {
        session = await this.#sessionFor(f.sid);
      } catch {
        return;
      }
      if (!session) return;
    }
    const plain = await this.c.open(session.key, TYPE.INFO, f.sid, sealed);
    if (!plain) {
      this.stats.foreignFrames++;
      return;
    }
    const info = decodeInfo(plain);
    if (!info && !this.pairedAt) {
      // 확정 전에는 그 후보만 버린다 (근처 기기가 세션 전체를 끝내지 못하도록)
      this.candidates.delete(f.sid);
      this.stats.badFrames++;
      return;
    }
    if (!info) {
      this.cancelReason = CANCEL_REASON.TOO_LARGE;
      this.#fail('bad-info');
      return;
    }
    if (!this.pairedAt) await this.#commit(f.sid, session);
    if (this.info || this.peerSid !== f.sid) return;
    this.blockSize = info.blockSize;
    this.info = info;
    this.#infoHash = await this.c.sha256(plain);
    this.lastProgressAt = this.now();
    this.#setState(STATE.REVIEW);
  }

  async #onAccept(f) {
    if (this.state !== STATE.OFFERING) return;
    const sealed = decodeSealed(f.payload);
    const plain = sealed && await this.c.open(this.#key, TYPE.ACCEPT, f.sid, sealed);
    if (!plain || !this.c.equalBytes(plain, this.#infoHash)) {
      this.stats.badFrames++;
      return;
    }
    this.lastProgressAt = this.now();
    this.firstDataAt = this.now();
    this.#setState(STATE.SENDING);
  }

  #onData(f) {
    if (this.state !== STATE.RECEIVING) return;
    const n = this.totalBlocks;
    const d = decodeData(f.payload, {
      blockSize: this.blockSize,
      totalBlocks: n,
      lastBlockSize: this.info.cipherSize - (n - 1) * this.blockSize,
    });
    if (!d) {
      this.stats.badFrames++;
      return;
    }
    if (!this.firstDataAt) this.firstDataAt = this.now();
    let fresh = 0;
    for (let i = 0; i < d.count; i++) {
      const b = d.startBlock + i;
      if (this.#got[b]) {
        this.stats.duplicateBlocks++;
        continue;
      }
      const from = i * this.blockSize;
      this.#buf.set(d.bytes.subarray(from, Math.min(from + this.blockSize, d.bytes.length)), b * this.blockSize);
      this.#got[b] = 1;
      fresh++;
    }
    if (!fresh) return;
    this.#gotCount += fresh;
    this.lastProgressAt = this.now();
    while (this.#base < n && this.#got[this.#base]) this.#base++;
    this.onChange(this);
    if (this.#gotCount === n) return this.#verifyReceived();
  }

  async #verifyReceived() {
    this.#setState(STATE.VERIFYING);
    const zip = await this.c.openPayload(this.#key, this.peerSid, this.info.payloadIv, this.#buf);
    this.#buf = null;
    // 실패하면 송신자가 60초를 기다리지 않도록 CANCEL(VERIFY_FAILED)을 보여준다
    if (!zip) return this.#verifyFailed('decrypt');
    const hash = await this.c.sha256(zip);
    if (!this.c.equalBytes(hash, this.info.sha256)) return this.#verifyFailed('hash-mismatch');
    this.zip = zip;
    this.#doneFrame = encodeSealed(await this.c.seal(this.#key, TYPE.DONE, this.sid, hash));
    this.#verifiedAt = this.now();
    this.onChange(this);
  }

  #verifyFailed(reason) {
    this.cancelReason = CANCEL_REASON.VERIFY_FAILED;
    this.#fail(reason);
  }

  #onAck(f) {
    if (this.state !== STATE.SENDING) return;
    const a = decodeAck(f.payload);
    if (!a) {
      this.stats.badFrames++;
      return;
    }
    const n = this.totalBlocks;
    this.peerHint = a.densityHint;
    const base = Math.min(a.base, n);
    const before = this.#ackedCount;
    for (let b = this.#firstUnacked; b < base; b++) this.#markAcked(b);
    for (let i = 0; i < WINDOW_BLOCKS && base + i < n; i++) if (bitAt(a.bitmap, i)) this.#markAcked(base + i);
    while (this.#firstUnacked < n && this.#acked[this.#firstUnacked]) this.#firstUnacked++;
    if (this.#ackedCount > before) {
      this.lastProgressAt = this.now();
      this.onChange(this);
    }
  }

  #markAcked(b) {
    if (!this.#acked[b]) {
      this.#acked[b] = 1;
      this.#ackedCount++;
    }
  }

  async #onDone(f) {
    if (this.state !== STATE.SENDING && this.state !== STATE.VERIFYING) return;
    const sealed = decodeSealed(f.payload);
    const theirs = sealed && await this.c.open(this.#key, TYPE.DONE, f.sid, sealed);
    if (!theirs || this.result !== null) return;
    this.#setState(STATE.VERIFYING);
    const ok = this.c.equalBytes(theirs, this.#zipHash);
    this.result = ok;
    this.#resultFrame = encodeSealed(await this.c.seal(this.#key, TYPE.RESULT, this.sid, new Uint8Array([ok ? 1 : 0])));
    if (ok) this.#finish();
    else this.#fail('hash-mismatch');
  }

  async #onResult(f) {
    if (this.result !== null || !this.zip) return;
    const sealed = decodeSealed(f.payload);
    const plain = sealed && await this.c.open(this.#key, TYPE.RESULT, f.sid, sealed);
    if (!plain || plain.length !== 1) return;
    this.result = plain[0] === 1;
    if (this.result) this.#finish();
    else this.#fail('hash-mismatch');
  }

  #onCancel(f) {
    // 확정한 상대(또는 확정 전 마지막 후보)의 CANCEL만 받는다
    if (f.sid !== (this.pairedAt ? this.peerSid : this.lastCandidate)) return;
    const reason = decodeCancel(f.payload);
    if (reason === null || this.state === STATE.DONE) return;
    if (this.state === STATE.FAILED) return;
    this.#fail(reason === CANCEL_REASON.VERIFY_FAILED ? 'peer-verify-failed' : 'peer-cancel');
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onChange(this);
  }

  #finish() {
    this.completedAt = this.now();
    this.#setState(STATE.DONE);
  }

  #fail(reason) {
    if (this.finished) return;
    this.failReason = reason;
    this.completedAt = this.now();
    this.#setState(STATE.FAILED);
  }

  #checkTimeouts() {
    if (this.finished) return;
    const t = this.now();
    if (this.pairedAt && t - Math.max(this.lastProgressAt, this.lastHeardAt) > TIMEOUT_MS) {
      this.cancelReason = CANCEL_REASON.TIMEOUT;
      this.#fail('timeout');
    }
    // 수신자: 로컬 검증은 끝났는데 RESULT가 오지 않음 → 받은 앱은 이미 검증됐으므로 완료로 본다
    if (this.#verifiedAt && this.result === null && t - this.#verifiedAt > RESULT_WAIT_MS) {
      this.result = true;
      this.#finish();
    }
  }

  // ───────────── 표시 (화면의 QR) ─────────────

  /** @returns {{bytes: Uint8Array, ecc: 'L' | 'M', kind: string}} */
  nextFrame() {
    this.#checkTimeouts();
    this.stats.framesShown++;
    if (this.cancelReason !== null && this.state === STATE.FAILED) {
      return this.#frame(TYPE.CANCEL, encodeCancel(this.cancelReason), 'cancel');
    }
    if (this.role === ROLE.SENDER) {
      if (this.#resultFrame) return this.#frame(TYPE.RESULT, this.#resultFrame, 'result');
      if (this.state === STATE.SENDING || this.state === STATE.VERIFYING) return this.#dataFrame();
      if (this.#infoFrame && this.state === STATE.OFFERING) return this.#frame(TYPE.INFO, this.#infoFrame, 'info');
      return this.#helloFrame();
    }
    if (this.#doneFrame) return this.#frame(TYPE.DONE, this.#doneFrame, 'done');
    if (this.state === STATE.RECEIVING || this.state === STATE.VERIFYING) {
      return this.firstDataAt ? this.#ackFrame() : this.#frame(TYPE.ACCEPT, this.#acceptFrame, 'accept');
    }
    return this.#helloFrame();
  }

  #frame(type, payload, kind, ecc = 'M') {
    return { bytes: encodeFrame({ sid: this.sid, type, payload }), ecc, kind };
  }

  #helloFrame() {
    if (!this.#hs) throw new Error('init() 먼저');
    return this.#frame(TYPE.HELLO, encodeHello({
      role: this.role,
      peerSid: this.pairedAt ? this.peerSid : this.lastCandidate,
      pubkey: this.#hs.publicKey,
      nonce: this.#hs.nonce,
      deviceName: this.deviceName,
    }), 'hello');
  }

  #ackFrame() {
    const n = this.totalBlocks;
    const base = this.#gotCount === n ? n : this.#base;
    const bitmap = new Uint8Array(BITMAP_BYTES);
    for (let i = 0; i < WINDOW_BLOCKS && base + i < n; i++) if (this.#got[base + i]) setBit(bitmap, i);
    const rate = this.decodeLog.length ? this.decodeLog.reduce((s, [, ok]) => s + ok, 0) / this.decodeLog.length : 0;
    return this.#frame(TYPE.ACK, encodeAck({ base, bitmap, densityHint: Math.round(rate * 255) }), 'ack');
  }

  #dataFrame() {
    this.#adaptDensity();
    const d = DENSITY[this.density];
    const n = this.totalBlocks;
    const k = blocksPerFrame(d, this.blockSize);
    const windowEnd = Math.min(this.#firstUnacked + WINDOW_BLOCKS, n);
    if (this.#cursor < this.#firstUnacked || this.#cursor >= windowEnd) this.#cursor = this.#firstUnacked;
    let start = this.#nextUnacked(this.#cursor, windowEnd);
    if (start < 0) start = this.#nextUnacked(this.#firstUnacked, windowEnd);
    if (start < 0) start = Math.min(this.#firstUnacked, n - 1); // 모두 ACK됨: DONE을 기다리며 아무 블록이나
    // 묶을 블록 수: 연속한 미수신 블록까지만 (이미 ACK된 블록을 다시 보내지 않도록)
    let count = 1;
    while (count < k && start + count < n && !this.#acked[start + count]) count++;
    const ct = this.#cipher.ct;
    const offset = start * this.blockSize;
    const bytes = ct.subarray(offset, Math.min(offset + count * this.blockSize, ct.length));
    this.#cursor = start + count;
    return this.#frame(TYPE.DATA, encodeData({ startBlock: start, count, bytes }), 'data', d.ecc);
  }

  #nextUnacked(from, end) {
    for (let b = from; b < end; b++) if (!this.#acked[b]) return b;
    return -1;
  }

  #adaptDensity() {
    if (!this.autoDensity || this.peerHint < 0) return;
    const t = this.now();
    if (t - this.lastDensityChange < DENSITY_INTERVAL_MS) return;
    const rate = this.peerHint / 255;
    let next = this.density;
    if (rate > 0.9 && this.density < DENSITY.length - 1) next++;
    else if (rate < 0.5 && this.density > 0) next--;
    if (next === this.density) return;
    this.density = next;
    this.lastDensityChange = t;
    this.stats.densityHistory.push(DENSITY[next].id);
  }

  /** UI용 요약: 진행률, 속도(B/s), 남은 시간(초) */
  summary() {
    const t = this.now();
    const size = this.role === ROLE.SENDER ? this.#cipher?.ct.length ?? 0 : this.info?.cipherSize ?? 0;
    const done = this.progress * size;
    const elapsed = this.firstDataAt ? (Math.max(t, this.completedAt || 0) - this.firstDataAt) / 1000 : 0;
    const rate = elapsed > 0 ? done / elapsed : 0;
    return {
      state: this.state,
      progress: this.progress,
      bytes: size,
      bytesPerSec: Math.round(rate),
      etaSec: rate > 0 ? Math.ceil((size - done) / rate) : null,
      stalled: this.stalled,
      sas: this.sas,
      density: DENSITY[this.density].id,
    };
  }
}
