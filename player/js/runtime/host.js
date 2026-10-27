// 앱 실행 host (ARCHITECTURE §4.1, §4.4, §4.6)
//   sandbox iframe을 만들고 bootstrap을 부팅한다. 메시지는 event.source와 스키마로 검증하고,
//   앱 ID는 메시지가 아니라 이 객체에 묶어 둔다 (앱이 다른 앱 ID를 사칭할 수 없음, T2).
//   DB에 의존하지 않는다: 파일과 저장소 스냅샷을 받고, 저장소 변경은 onStorage로 넘긴다.

import { bootstrapMain } from './bootstrap.js';
import { cssRefs, resolveVirtual, applyEdits, rewriteCssText, rewriteSrcset, createStorageBatcher } from './rewrite.js';
import { VBASE, PLAN_VERSION } from '../installer/rewrite-plan.js';

export const SANDBOX = 'allow-scripts allow-pointer-lock allow-modals allow-forms';
export const ALLOW = "fullscreen; autoplay; gamepad; camera 'none'; microphone 'none'; geolocation 'none'";
export const CSP = [
  "default-src 'none'",
  "script-src blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src blob: 'unsafe-inline'",
  'img-src blob: data:',
  'media-src blob: data:',
  'font-src blob: data:',
  'connect-src blob: data:',
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export const BOOT_TIMEOUT = 10_000;
export const FLUSH_TIMEOUT = 500;
/** load 뒤 bootstrap의 생존 응답(pong)을 기다리는 시간. 없으면 다른 문서로 이동한 것으로 본다 (§4.6) */
export const PONG_TIMEOUT = 1500;
/** 종료 시 남은 DB 기록을 기다리는 최대 시간 (종료는 항상 가능해야 한다, T4) */
export const CLOSE_WRITE_TIMEOUT = 2000;
/** 앱별 localStorage 상한. shim도 검사하지만 앱이 shim을 거치지 않을 수 있으므로 host가 다시 센다 */
export const STORAGE_QUOTA = 5 * 1024 * 1024; // bytes, (key + value) × 2

const STORAGE_MAX_KEYS = 10_000;
const STORAGE_MAX_CHARS = 6 * 1024 * 1024; // 배치 하나의 상한
const PENDING_WRITES_MAX = 20;
const LOG_MAX = 50;

function randomNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const HELPERS = { cssRefs, resolveVirtual, applyEdits, rewriteCssText, rewriteSrcset, createStorageBatcher };

/** srcdoc 문서. 함수 소스를 인라인하므로 한 번만 만든다 */
let srcdocCache = null;
export function buildSrcdoc() {
  if (srcdocCache) return srcdocCache;
  const script = [
    '(() => {',
    "'use strict';",
    `const VBASE = ${JSON.stringify(VBASE)};`,
    ...Object.entries(HELPERS).map(([name, fn]) => `const ${name} = ${fn.toString()};`),
    `(${bootstrapMain.toString()})();`,
    '})();',
  ].join('\n');
  if (/<\/script/i.test(script)) throw new Error('bootstrap 소스에 닫는 script 태그 문자열이 있습니다');
  srcdocCache = '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<script>${script}</` + 'script></head><body></body></html>';
  return srcdocCache;
}

/**
 * 실행 전 점검. 실행할 수 없으면 사용자에게 보일 오류 문구, 괜찮으면 null.
 *   - 순환 import는 v1에서 지원하지 않는다 (ARCHITECTURE §4.3)
 *   - plan 버전이 다르면 다시 계산해야 한다 (DATABASE §7) → needsReplan
 * @param {{rewritePlan?: object, status?: string, error?: string | null}} app
 * @returns {{error: string | null, needsReplan: boolean}}
 */
export function preflight(app) {
  if (app.status === 'broken') return { error: app.error || '앱을 실행할 수 없습니다.', needsReplan: false };
  const plan = app.rewritePlan;
  if (!plan || plan.version !== PLAN_VERSION) return { error: null, needsReplan: true };
  const cycle = (plan.warnings || []).find((w) => w.startsWith('cyclic-import:'));
  if (cycle) {
    return { error: `서로를 불러오는 모듈(순환 import)이 있어 실행할 수 없습니다: ${cycle.slice('cyclic-import:'.length)}`, needsReplan: false };
  }
  return { error: null, needsReplan: false };
}

/**
 * STORAGE_BATCH 스키마 검증. 통과하면 정규화한 배치, 아니면 null.
 * @returns {{set: Record<string, string>, remove: string[], clear: boolean} | null}
 */
export function validateStorageBatch(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const set = b.set ?? {};
  const remove = b.remove ?? [];
  const clear = b.clear ?? false;
  if (typeof set !== 'object' || set === null || Array.isArray(set) || !Array.isArray(remove) || typeof clear !== 'boolean') return null;
  const entries = Object.entries(set);
  if (entries.length + remove.length > STORAGE_MAX_KEYS) return null;
  let chars = 0;
  for (const [k, v] of entries) {
    if (typeof v !== 'string') return null;
    chars += k.length + v.length;
  }
  for (const k of remove) {
    if (typeof k !== 'string') return null;
    chars += k.length;
  }
  if (chars > STORAGE_MAX_CHARS) return null;
  return { set: Object.fromEntries(entries), remove: [...remove], clear };
}

/**
 * @typedef {{reason: 'closed' | 'navigation' | 'boot-timeout' | 'boot-error' | 'storage-error', message?: string, logs: string[]}} ExitInfo
 */

export class AppRun {
  #container;
  #iframe = null;
  #files;
  #plan;
  #entry;
  #storage;
  #onStorage;
  #onExit;
  #onLog;

  #bootSent = false;
  #started = false;
  #finished = false;
  #timers = new Set();
  #pendingKill = 0;
  /** bootstrap만 아는 비밀. 수명 신호(started, pong, error) 인증용 (앱이 위조하지 못하게) */
  #nonce = randomNonce();
  #srcdocLoaded = false;
  /** 마지막 load 뒤 보낸 생존 확인 */
  #challenge = null;
  #bootTimer = 0;
  #writes = Promise.resolve();
  #pendingWrites = 0;
  /** 앱 저장소 키별 사용량 (bytes) */
  #usage = new Map();
  #onFlushed = null;
  #startResolve;
  #startReject;
  #messageHandler;
  /** @type {string[]} 최근 앱 로그 (오류 진단용) */
  logs = [];

  /**
   * @param {{
   *   container: HTMLElement,
   *   files: Map<string, {mime: string, blob: Blob}>,
   *   plan: object, entry?: string,
   *   storage?: Record<string, string>,
   *   onStorage?: (batch: {set: Record<string, string>, remove: string[], clear: boolean}) => Promise<void>,
   *   onExit?: (info: ExitInfo) => void,
   *   onLog?: (message: string) => void,
   * }} options
   */
  constructor({ container, files, plan, entry = 'index.html', storage = {}, onStorage, onExit, onLog }) {
    this.#container = container;
    this.#files = files;
    this.#plan = plan;
    this.#entry = entry;
    this.#storage = storage;
    for (const [k, v] of Object.entries(storage)) if (typeof v === 'string') this.#usage.set(k, (k.length + v.length) * 2);
    this.#onStorage = onStorage ?? (async () => {});
    this.#onExit = onExit ?? (() => {});
    this.#onLog = onLog ?? (() => {});
  }

  get iframe() {
    return this.#iframe;
  }

  /** 부팅을 시작한다. started를 받으면 resolve, 부팅 실패·시간 초과면 reject */
  start() {
    if (this.#iframe) throw new Error('이미 시작했습니다');
    const started = new Promise((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
    });
    started.catch(() => {}); // 호출자가 기다리지 않아도 unhandled가 되지 않게

    const iframe = document.createElement('iframe');
    iframe.className = 'app-frame';
    iframe.setAttribute('sandbox', SANDBOX);
    iframe.setAttribute('allow', ALLOW);
    iframe.setAttribute('title', '앱');
    iframe.addEventListener('load', () => this.#onLoad());
    this.#iframe = iframe;

    this.#messageHandler = (e) => this.#onMessage(e);
    window.addEventListener('message', this.#messageHandler);
    this.#bootTimer = this.#later(() => this.#fail('boot-timeout', '앱이 10초 안에 시작되지 않았습니다'), BOOT_TIMEOUT);

    iframe.srcdoc = buildSrcdoc();
    this.#container.append(iframe);
    return started;
  }

  /**
   * 종료: 미반영 저장소 쓰기를 flush(최대 500ms)하고 DB 기록을 기다린 뒤 iframe을 제거한다.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#finished) return;
    const win = this.#iframe?.contentWindow;
    if (win && this.#started) {
      await new Promise((resolve) => {
        this.#onFlushed = resolve;
        win.postMessage({ type: 'bebeam:flush' }, '*');
        setTimeout(resolve, FLUSH_TIMEOUT);
      });
    }
    this.#finish({ reason: 'closed' });
    await Promise.race([this.#writes, new Promise((r) => setTimeout(r, CLOSE_WRITE_TIMEOUT))]);
  }

  #later(fn, ms) {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
    return t;
  }

  #log(message) {
    this.logs.push(message);
    if (this.logs.length > LOG_MAX) this.logs.shift();
    this.#onLog(message);
  }

  #onLoad() {
    // 첫 load는 srcdoc 문서다. 이후 load는 bootstrap의 재렌더링이거나 앱의 self-navigation이다.
    // 신호의 개수로 구별하지 않고, 문서 안에 bootstrap이 살아 있는지 직접 확인한다:
    // nonce를 아는 bootstrap만 pong에 답할 수 있고, 다른 문서로 이동했으면 아무도 답하지 않는다 (fail-closed)
    if (!this.#srcdocLoaded) {
      this.#srcdocLoaded = true;
      return;
    }
    const challenge = randomNonce();
    this.#challenge = challenge;
    clearTimeout(this.#pendingKill);
    this.#timers.delete(this.#pendingKill);
    this.#pendingKill = this.#later(() => {
      if (this.#challenge === challenge) this.#fail('navigation', '앱이 허용되지 않은 동작을 시도해 종료되었습니다');
    }, PONG_TIMEOUT);
    this.#iframe.contentWindow?.postMessage({ type: 'bebeam:ping', challenge }, '*');
  }

  #onPong(m) {
    if (m.nonce !== this.#nonce || m.challenge !== this.#challenge) return;
    this.#challenge = null;
    clearTimeout(this.#pendingKill);
    this.#timers.delete(this.#pendingKill);
    this.#pendingKill = 0;
  }

  /** 누적 사용량이 상한 안이면 반영하고 true */
  #reserve(batch) {
    const next = batch.clear ? new Map() : new Map(this.#usage);
    for (const k of batch.remove) next.delete(k);
    for (const [k, v] of Object.entries(batch.set)) next.set(k, (k.length + v.length) * 2);
    let total = 0;
    for (const n of next.values()) total += n;
    if (total > STORAGE_QUOTA) return false;
    this.#usage = next;
    return true;
  }

  #onMessage(e) {
    if (this.#finished || !this.#iframe || e.source !== this.#iframe.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;

    switch (m.type) {
      case 'bebeam:ready': {
        if (this.#bootSent) return;
        this.#bootSent = true;
        const files = {};
        for (const [path, f] of this.#files) files[path] = new Blob([f.blob], { type: f.mime });
        // opaque origin이라 targetOrigin은 '*'만 가능하다. 보내는 것은 이 앱 자신의 파일과 데이터뿐이다
        this.#iframe.contentWindow.postMessage({
          type: 'bebeam:boot', files, plan: this.#plan, entry: this.#entry,
          storage: this.#storage, parentOrigin: location.origin, nonce: this.#nonce,
        }, '*');
        return;
      }
      case 'bebeam:rendering':
        // 재렌더링 예고. 감지는 load 뒤 생존 확인(pong)으로 하므로 여기서는 기록만 한다
        if (m.nonce !== this.#nonce) this.#log('위조된 rendering 신호를 무시했습니다');
        return;
      case 'bebeam:pong':
        this.#onPong(m);
        return;
      case 'bebeam:started':
        if (m.nonce !== this.#nonce) {
          this.#log('위조된 started 신호를 무시했습니다');
          return;
        }
        if (!this.#started) {
          this.#started = true;
          clearTimeout(this.#bootTimer);
          this.#startResolve();
        }
        return;
      case 'bebeam:storage': {
        const batch = validateStorageBatch(m.batch);
        if (!batch) {
          this.#log('잘못된 저장소 메시지를 무시했습니다');
          return;
        }
        if (this.#pendingWrites >= PENDING_WRITES_MAX) {
          this.#log('저장 요청이 너무 많아 무시했습니다');
          return;
        }
        if (!this.#reserve(batch)) {
          this.#log('저장 공간(5MB)을 넘는 저장 요청을 무시했습니다');
          return;
        }
        this.#pendingWrites++;
        this.#writes = this.#writes.then(() => this.#onStorage(batch)).catch((err) => {
          this.#log(`저장 실패: ${err?.message ?? err}`);
        }).finally(() => {
          this.#pendingWrites--;
        });
        return;
      }
      case 'bebeam:flushed':
        this.#onFlushed?.();
        return;
      case 'bebeam:navigating':
        if (this.#started) this.#fail('navigation', '앱이 허용되지 않은 동작을 시도해 종료되었습니다');
        return;
      case 'bebeam:log':
        if (typeof m.message === 'string') this.#log(m.message.slice(0, 500));
        return;
      case 'bebeam:error':
        // bootstrap의 부팅 오류만 받는다. 앱이 보낸 문구가 플레이어 오류 화면에 그대로 뜨지 않게
        if (m.nonce !== this.#nonce) {
          this.#log('위조된 error 신호를 무시했습니다');
          return;
        }
        if (!this.#started) this.#fail('boot-error', typeof m.message === 'string' ? m.message.slice(0, 500) : '앱을 시작하지 못했습니다');
        return;
      default:
    }
  }

  #fail(reason, message) {
    if (this.#finished) return;
    if (!this.#started) this.#startReject(Object.assign(new Error(message), { reason, logs: [...this.logs] }));
    this.#finish({ reason, message });
  }

  #finish({ reason, message }) {
    if (this.#finished) return;
    this.#finished = true;
    // 시작 전에 끝나면 start()도 끝낸다 (기다리는 쪽이 멈추지 않게)
    if (!this.#started) this.#startReject?.(Object.assign(new Error(message ?? '앱이 종료되었습니다'), { reason, logs: [...this.logs] }));
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    window.removeEventListener('message', this.#messageHandler);
    // iframe 문서가 사라지면 그 안에서 만든 blob URL도 함께 해제된다
    this.#iframe?.remove();
    this.#onExit({ reason, message, logs: [...this.logs] });
  }
}
