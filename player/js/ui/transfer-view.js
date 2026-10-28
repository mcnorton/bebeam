// 단방향 전송 화면 (TASK M7, F-05)
//   보내기: 흰 바탕에 짧은 변을 채우는 QR 애니메이션. 받는 쪽 상태는 모르므로 [완료]로 닫는다. 여러 명이 함께 받을 수 있다.
//   받기: 위 = 스캐너 정사각형(한 변 = 화면 세로의 1/2, 후면 카메라 영상의 가운데 정사각형), 아래 = 전송 정보.
//   다 받으면 스캐너 칸 위에 앱 정보와 [취소] [설치 시작]을 띄운다(설치 동의는 받은 뒤에).
//   앱이 제공한 이름은 textContent로만 넣는다. ?diag면 받는 화면에 카메라·디코더 수치를 보인다.

import { FountainSender, FountainReceiver, STATE, SPEED, DEFAULT_SPEED } from '../transfer/broadcast.js';
import { QrDisplay, QrScanner, scannerErrorMessage } from '../transfer/link.js';
import { packApp, analyzeReceived, installReceived, formatEstimate, estimateSeconds, TRANSFER_WARN } from '../transfer/pipeline.js';
import { clean, NAME_MAX, DEFAULT_NAME } from '../installer/meta.js';
import { formatBytes } from '../installer/install.js';
import { h } from './dialogs.js';
import { icon } from './icons.js';
import { cleanUserName } from '../names.js';
import { getUserName, getDuplicatePolicy } from '../settings.js';
import { listApps } from '../db.js';
import { planDuplicate } from '../installer/duplicates.js';
import { duplicateNote } from './add-sheet.js';

/** 상태 문구: 문자열 또는 [아이콘 이름, 문구] */
function withIcon(headline) {
  return Array.isArray(headline) ? [icon(headline[0]), headline[1]] : [headline];
}

export const ROLE = Object.freeze({ SENDER: 1, RECEIVER: 2 });

const UI_INTERVAL = 250;
const SPEED_LABEL = { slow: '느리게', normal: '보통', fast: '빠르게' };
const SPEED_KEY = 'bebeam.tx.speed';

/** 보낸 쪽이 정한 이름은 C-5와 같이 다듬어 보여준다 (길이, 양방향 제어·폭 없는 문자) */
function appName(meta) {
  return (meta && clean(meta.name, NAME_MAX)) || DEFAULT_NAME;
}

function formatRate(bps) {
  if (!bps) return '';
  const kbs = bps / 1024;
  return kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(1)} KB/s`;
}

function savedSpeed() {
  try {
    const s = localStorage.getItem(SPEED_KEY);
    return SPEED[s] ? s : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
}

/**
 * 전송 화면을 연다. 닫히면 resolve.
 * @param {{
 *   db: IDBDatabase, role: number, appId?: string,
 *   onInstalled?: (app: object) => void,
 *   onLaunch?: (appId: string) => void,
 * }} o
 */
export function openTransfer(o) {
  return new Promise((resolve) => {
    const View = o.role === ROLE.SENDER ? SendView : ReceiveView;
    new View({ ...o, onClose: resolve }).start();
  });
}

/** 모달 공통: 뒤쪽 셸 inert, Escape·✕로 닫기, 포커스 되돌리기 */
class Modal {
  root;
  closing = false;
  #o;
  #prevFocus = null;
  #shell = null;
  #onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  constructor(o, className, label, children) {
    this.#o = o;
    const close = h('button', { type: 'button', class: 'tx-close', 'aria-label': '닫기' }, [icon('x')]);
    close.addEventListener('click', () => this.close());
    this.root = h('div', { class: `transfer ${className}`, role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-label': label }, [close, ...children]);
  }

  get o() {
    return this.#o;
  }

  open() {
    this.#prevFocus = document.activeElement;
    this.#shell = document.getElementById('shell');
    if (this.#shell) this.#shell.inert = true;
    document.body.append(this.root);
    this.root.focus();
    document.addEventListener('keydown', this.#onKey);
  }

  /** 하위 클래스가 정리를 덧붙인다 */
  teardown() {}

  close() {
    if (this.closing) return;
    this.closing = true;
    this.teardown();
    document.removeEventListener('keydown', this.#onKey);
    this.root.remove();
    if (this.#shell) this.#shell.inert = false;
    if (this.#prevFocus?.isConnected) this.#prevFocus.focus();
    this.#o.onClose();
  }
}

// ───────── 보내기 ─────────

class SendView extends Modal {
  #canvas;
  #head;
  #hints;
  #select;
  #display = null;
  #sender = null;
  #onResize = () => this.#display?.invalidate();

  constructor(o) {
    const canvas = h('canvas', { class: 'tx-qr', role: 'img', 'aria-label': '전송용 QR 코드' });
    const head = h('p', { class: 'tx-send-head', 'aria-live': 'polite', text: '준비하는 중…' });
    const hints = h('div', { class: 'tx-send-info' });
    const select = h('select', { 'aria-label': '전송 속도' },
      Object.keys(SPEED).map((k) => h('option', { value: k, text: SPEED_LABEL[k] })));
    const done = h('button', { type: 'button', class: 'btn btn-primary', text: '완료' });
    const actions = h('div', { class: 'tx-send-actions' }, [h('label', { class: 'tx-speed' }, [h('span', { text: '속도' }), select]), done]);
    super(o, 'tx-send', '앱 보내기', [
      h('div', { class: 'tx-send-sq' }, [canvas]),
      h('div', { class: 'tx-send-side' }, [head, hints, actions]),
    ]);
    this.#canvas = canvas;
    this.#head = head;
    this.#hints = hints;
    this.#select = select;
    select.value = savedSpeed();
    select.addEventListener('change', () => this.#setSpeed(select.value));
    done.addEventListener('click', () => this.close());
  }

  async start() {
    this.open();
    addEventListener('resize', this.#onResize);
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
      this.#fail(['lock', '이 주소에서는 보낼 수 없어요'], '주소창이 https://로 시작하는 주소에서 플레이어를 열어 주세요.');
      return;
    }
    let sender;
    try {
      const [offer, me] = await Promise.all([packApp(this.o.db, this.o.appId), getUserName(this.o.db)]);
      sender = await new FountainSender({ ...offer, sender: me, speed: this.#select.value }).init();
    } catch (err) {
      console.error(err);
      this.#fail(['circle-x', '앱을 보낼 준비를 하지 못했어요'], err?.message ?? '');
      return;
    }
    if (this.closing) return;
    this.#sender = sender;
    const name = clean(sender.name, NAME_MAX) || DEFAULT_NAME;
    this.#head.textContent = `‘${name}’ 보내는 중`;
    this.#display = new QrDisplay({ sender, canvas: this.#canvas });
    await this.#display.start();
    this.#renderHints();
  }

  #setSpeed(speed) {
    try {
      localStorage.setItem(SPEED_KEY, speed);
    } catch { /* 저장 못 해도 이번 전송에는 적용된다 */ }
    this.#sender?.setSpeed(speed);
    this.#display?.invalidate();
    this.#renderHints();
  }

  #renderHints() {
    const s = this.#sender;
    const lines = [
      ['받는 쪽 화면에서 진행을 확인하세요.'],
      ['여러 명이 함께 받을 수 있어요.'],
      ['화면 밝기를 최대로 하면 더 잘 읽혀요.'],
    ];
    if (s && s.zip.length > TRANSFER_WARN) {
      const sec = estimateSeconds(s.zip.length) * (SPEED.normal.bytes / SPEED[s.speed].bytes);
      lines.push([`큰 앱이라 오래 걸려요 (${formatEstimate(sec)})`, 'warn']);
    }
    if (this.#display && !this.#display.wakeLockSupported) lines.push(['화면이 꺼지지 않게 해 주세요.', 'warn']);
    this.#hints.replaceChildren(...lines.map(([text, cls]) => h('p', { class: `tx-hint${cls ? ` ${cls}` : ''}`, text })));
  }

  #fail(headline, detail) {
    this.#head.replaceChildren(...withIcon(headline));
    this.#hints.replaceChildren(h('p', { class: 'tx-hint warn', text: detail }));
  }

  teardown() {
    removeEventListener('resize', this.#onResize);
    this.#display?.stop();
    this.#display = null;
  }
}

// ───────── 받기 ─────────

class ReceiveView extends Modal {
  #scan;
  #video;
  #headline;
  #sub;
  #bar;
  #fill;
  #panel;
  #detail;
  #actions;
  #diag = null;
  #switch;
  #receiver = null;
  #scanner = null;
  #uiTimer = 0;
  #actionsKey = '';
  #installed = null;
  #installError = null;
  #installing = false;
  #approved = false;
  #analysis = null;
  #policy = 'separate';
  /** 같은 이름의 앱 처리 미리 보기 (installer/duplicates.js) */
  #plan = null;
  #analyzing = false;
  #lastHits = 0;

  constructor(o) {
    const video = h('video', { class: 'tx-preview', playsinline: true, muted: true, 'aria-hidden': 'true' });
    const detail = h('div', { class: 'tx-detail' });
    const actions = h('div', { class: 'tx-actions' });
    const panel = h('div', { class: 'tx-panel', hidden: true }, [detail, actions]);
    const scan = h('div', { class: 'tx-scan' }, [video, h('div', { class: 'tx-guide', 'aria-hidden': 'true' }), panel]);
    const headline = h('p', { class: 'tx-headline', 'aria-live': 'polite' });
    const sub = h('p', { class: 'tx-sub' });
    const fill = h('div', { class: 'tx-bar-fill' });
    const bar = h('div', { class: 'tx-bar', role: 'progressbar', 'aria-label': '받는 진행률', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, [fill]);
    const sw = h('button', { type: 'button', class: 'tx-switch', hidden: true }, [icon('switch-camera'), '카메라 전환']);
    const info = h('div', { class: 'tx-info' }, [headline, bar, sub]);
    const diag = new URLSearchParams(location.search).has('diag') ? h('p', { class: 'tx-diag' }) : null;
    if (diag) info.append(diag);
    super(o, 'tx-recv', 'QR로 받기', [sw, scan, info]);
    this.#scan = scan;
    this.#video = video;
    this.#headline = headline;
    this.#sub = sub;
    this.#bar = bar;
    this.#fill = fill;
    this.#panel = panel;
    this.#detail = detail;
    this.#actions = actions;
    this.#diag = diag;
    this.#switch = sw;
    sw.addEventListener('click', () => this.#switchCamera());
  }

  async start() {
    this.open();
    await this.#begin();
  }

  async #begin() {
    this.#installed = null;
    this.#installError = null;
    this.#installing = false;
    this.#approved = false;
    this.#analysis = null;
    this.#plan = null;
    this.#analyzing = false;
    this.#setProgress(null);
    this.#setActions([]);
    // 카메라(getUserMedia)와 SHA-256(crypto.subtle)은 보안 컨텍스트에서만 있다. http://내부IP로 열면 둘 다 없다
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
      this.#setStatus(['lock', '이 주소에서는 받을 수 없어요']);
      this.#setActions([['닫기', () => this.close(), 'primary']],
        ['카메라는 https:// 주소에서만 동작해요.', '주소창이 https://로 시작하는 주소에서 플레이어를 열어 주세요.']);
      return;
    }
    const receiver = new FountainReceiver({ onChange: () => this.#render() });
    this.#receiver = receiver;
    const scanner = new QrScanner({ receiver, video: this.#video });
    this.#scanner = scanner;
    this.#setStatus(['camera', '카메라 사용을 허용해 주세요'], '보내는 쪽 화면의 QR을 읽으려면 카메라가 필요해요.');
    try {
      await scanner.start();
    } catch (err) {
      scanner.stop();
      if (this.#scanner !== scanner) return;
      this.#scanner = null;
      this.#setStatus(['camera', '카메라를 쓸 수 없어요']);
      this.#setActions([['다시 시도', () => this.#retry()], ['닫기', () => this.close(), 'primary']], scannerErrorMessage(err));
      return;
    }
    if (this.closing || this.#scanner !== scanner) {
      scanner.stop();
      return;
    }
    this.#switch.hidden = false;
    clearInterval(this.#uiTimer);
    this.#uiTimer = setInterval(() => this.#render(), UI_INTERVAL);
    this.#render();
  }

  async #switchCamera() {
    try {
      await this.#scanner?.switchCamera();
    } catch (err) {
      this.#setStatus(['camera', '카메라를 바꾸지 못했어요'], scannerErrorMessage(err), true);
    }
  }

  /** @param {string | [string, string]} headline [아이콘 이름, 문구]이면 앞에 선 아이콘을 붙인다 */
  #setStatus(headline, sub = '', warn = false) {
    this.#headline.replaceChildren(...withIcon(headline));
    this.#sub.textContent = sub;
    this.#sub.classList.toggle('warn', warn);
  }

  /** @param {number | null} p 0–1, null이면 막대를 비운다 */
  #setProgress(p) {
    const pct = p == null ? 0 : Math.floor(p * 100);
    this.#fill.style.width = `${pct}%`;
    this.#bar.setAttribute('aria-valuenow', String(pct));
  }

  /**
   * 끝난 뒤의 버튼과 설명은 스캐너 칸 위에 띄운다.
   * @param {[string, () => void, string?][]} list
   * @param {string | string[]} [detail] 배열이면 한 줄씩, 첫 줄을 굵게
   */
  #setActions(list, detail = '') {
    this.#panel.hidden = list.length === 0;
    const lines = [detail].flat().filter(Boolean);
    this.#detail.classList.toggle('lines', Array.isArray(detail));
    if (lines.join('\n') !== this.#detail.dataset.text) {
      this.#detail.dataset.text = lines.join('\n');
      this.#detail.replaceChildren(...lines.map((t) => h('p', { text: t })));
    }
    const key = list.map(([label, , kind]) => `${label}:${kind ?? ''}`).join('|');
    if (key === this.#actionsKey) return;
    this.#actionsKey = key;
    this.#actions.replaceChildren(...list.map(([label, fn, kind]) => {
      const b = h('button', { type: 'button', class: `btn${kind ? ` btn-${kind}` : ''}`, text: label });
      b.addEventListener('click', fn);
      return b;
    }));
    this.#actions.querySelector('.btn-primary')?.focus();
  }

  #render() {
    const r = this.#receiver;
    if (!r || this.closing) return;
    this.#renderDiag();
    // 디코딩에 성공하는 동안 틀을 밝게 (손에 든 채 맞추는 데 도움)
    this.#scan.classList.toggle('hit', r.stats.decodeHits > this.#lastHits);
    this.#lastHits = r.stats.decodeHits;
    const legacy = r.legacySeen ? '보내는 쪽 BeBeam을 2.0 이상으로 업데이트해 주세요.' : '';

    switch (r.state) {
      case STATE.SCANNING:
        this.#setProgress(null);
        if (legacy) this.#setStatus(['triangle-alert', '이전 버전의 QR이에요'], legacy, true);
        else this.#setStatus(['camera', '보내는 쪽 QR을 틀 안에 맞춰 주세요'], '15–30cm 거리에서, 반사광이 보이면 살짝 기울여 주세요.');
        return;
      case STATE.RECEIVING:
      case STATE.STALLED: {
        const m = r.meta;
        const pct = Math.floor(r.progress * 100);
        this.#setProgress(r.progress);
        const head = ['inbox', `‘${appName(m)}’ · ${formatBytes(m.zipSize)}`];
        if (r.state === STATE.STALLED) {
          this.#setStatus(head, `${pct}% · QR을 틀 안에 맞춰 주세요`, true);
        } else {
          const eta = r.etaSeconds != null ? `약 ${formatEstimate(r.etaSeconds).replace('약 ', '')} 남음` : '';
          this.#setStatus(head, [`${pct}%`, eta, formatRate(r.bytesPerSecond)].filter(Boolean).join(' · '));
        }
        return;
      }
      case STATE.VERIFYING:
        this.#setProgress(1);
        this.#setStatus(['search', `‘${appName(r.meta)}’ 확인 중…`], '100%');
        return;
      case STATE.DONE:
        this.#setProgress(1);
        this.#onReceived(r);
        return;
      case STATE.FAILED:
        this.#scanner?.stop();
        this.#scanner = null;
        this.#switch.hidden = true;
        clearInterval(this.#uiTimer);
        this.#setProgress(null);
        if (r.failReason === 'too-many-symbols') {
          this.#setStatus(['circle-x', '이 화면으로는 받을 수 없어요'], '조각을 충분히 모았는데도 풀리지 않았어요. 다른 화면이 섞였을 수 있어요.', true);
          this.#setActions([['닫기', () => this.close()], ['다시 받기', () => this.#retry(), 'primary']]);
        } else if (r.failReason === 'hash-mismatch') {
          this.#setStatus(['circle-x', '받은 파일이 손상되었어요'], '다시 받으면 처음부터 모아요.', true);
          this.#setActions([['닫기', () => this.close()], ['다시 받기', () => this.#retry(), 'primary']]);
        } else {
          this.#setStatus(['triangle-alert', 'QR을 찾지 못했어요'], '3분 동안 읽지 못해 멈췄어요. 준비되면 [다시 시도]를 눌러 주세요.', true);
          this.#setActions([['닫기', () => this.close()], ['다시 시도', () => this.#retry(), 'primary']]);
        }
        return;
      default:
    }
  }

  #renderDiag() {
    if (!this.#diag) return;
    const r = this.#receiver, s = this.#scanner?.stats;
    const hit = r.stats.decodeTries ? Math.round((r.stats.decodeHits / r.stats.decodeTries) * 100) : 0;
    this.#diag.textContent = [
      `카메라 ${s?.width}×${s?.height}${s?.fps ? ` @${Math.round(s.fps)}` : ''} · 크롭 ${s?.crop} · ${this.#scanner?.facing ?? '-'}`,
      `디코더 ${this.#scanner?.decoderKind ?? '-'} · ${s?.decodeMs?.toFixed(1) ?? '-'}ms · 인식 ${hit}% (${r.stats.decodeHits}/${r.stats.decodeTries})`,
      `프레임 ${r.stats.frames} · 다른 송신자 ${r.stats.foreign} · 심볼 ${r.received}/${r.k} · 풀림 ${r.decoded}`,
    ].join('\n');
  }

  async #onReceived(r) {
    if (this.#scanner) {
      this.#scanner.stop();
      this.#scanner = null;
      this.#switch.hidden = true;
    }
    if (this.#installed) {
      clearInterval(this.#uiTimer);
      // W-06 대신 이 화면에서 설치 동의를 받았으므로 외부 리소스 경고(C-6)는 설치 뒤 여기서 보여준다
      const ext = this.#installed.externalRefs ?? [];
      const warn = ext.length ? `이 앱은 인터넷의 파일을 사용해서(${ext.slice(0, 3).join(', ')}${ext.length > 3 ? ' 외' : ''}) 일부 기능이 동작하지 않을 수 있어요.` : '';
      this.#setStatus(['circle-check', '설치 완료'], this.#plan?.kind === 'overwrite'
        ? `‘${this.#installed.name}’ 앱을 새것으로 바꿨어요. 점수·설정은 그대로예요.`
        : `목록에 ‘${this.#installed.name}’ 앱을 추가했어요.`);
      this.#setActions([['닫기', () => this.close()], ['바로 실행', () => this.#launch(), 'primary']], warn);
      return;
    }
    if (this.#installError) {
      clearInterval(this.#uiTimer);
      this.#setStatus(['circle-x', '설치할 수 없어요']);
      this.#setActions([['닫기', () => this.close(), 'primary']], this.#installError);
      return;
    }
    if (this.#installing || this.#analyzing) return;
    if (!this.#analysis) {
      // 동의 전에 먼저 분석한다: 이름·파일 수·크기는 송신자가 주장한 META가 아니라 실제 zip에서 (보안 검토 T7.8)
      this.#analyzing = true;
      this.#setStatus(['search', '받은 앱을 살펴보는 중…']);
      try {
        this.#analysis = await analyzeReceived(r.zip, r.meta.name);
        this.#policy = await getDuplicatePolicy(this.o.db);
        this.#plan = planDuplicate(await listApps(this.o.db), this.#analysis.name, this.#policy);
      } catch (err) {
        console.error(err);
        this.#installError = err?.name === 'InstallError' ? err.message : '받은 앱을 설치할 수 없습니다.';
      }
      this.#analyzing = false;
      if (!this.closing) this.#onReceived(r);
      return;
    }
    if (!this.#approved) {
      // 받는 것은 버튼 없이 했지만 설치는 받은 앱을 다시 보여주고 동의를 받는다 (T11)
      const a = this.#analysis;
      this.#setStatus(['package', '다 받았어요. 설치를 시작할까요?'], '받으려던 앱이 맞는지 확인하세요.');
      const from = cleanUserName(r.meta.sender);
      this.#setActions([['취소', () => this.close()], [this.#plan?.kind === 'overwrite' ? '덮어쓰기' : '설치 시작', () => this.#approve(r), 'primary']], [
        clean(a.name, NAME_MAX) || DEFAULT_NAME,
        `파일 ${a.fileCount}개 · ${formatBytes(a.size)}`,
        from ? `보낸 사람: ${from}` : '',
        duplicateNote(this.#plan),
      ].filter(Boolean));
      return;
    }
    this.#installing = true;
    this.#setStatus(['package', '설치하는 중…']);
    this.#setActions([]);
    try {
      this.#installed = await installReceived(this.o.db, this.#analysis, { senderName: cleanUserName(r.meta.sender) || null, policy: this.#policy, expect: this.#plan });
      this.o.onInstalled?.(this.#installed);
    } catch (err) {
      console.error(err);
      this.#installError = err?.name === 'InstallError' ? err.message : '받은 앱을 설치하지 못했습니다.';
    }
    this.#installing = false;
    if (!this.closing) this.#onReceived(r);
  }

  #approve(r) {
    if (this.#approved || this.closing) return;
    this.#approved = true;
    this.#onReceived(r);
  }

  #launch() {
    const id = this.#installed?.id;
    this.close();
    if (id) this.o.onLaunch?.(id);
  }

  async #retry() {
    this.teardown();
    this.#actionsKey = '';
    await this.#begin();
  }

  teardown() {
    clearInterval(this.#uiTimer);
    this.#scanner?.stop();
    this.#scanner = null;
    this.#receiver = null;
  }
}
