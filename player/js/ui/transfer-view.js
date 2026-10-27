// 맞대기 전송 화면 (F-05, W-14, W-15)
//   카메라에 가까운 절반은 미리보기·상태, 먼 절반은 QR. 송신과 수신이 같은 화면을 쓴다.
//   앱이 제공한 이름은 textContent로만 넣는다.

import { TransferSession, ROLE, STATE, CANCEL_REASON } from '../transfer/session.js';
import { OpticalLink, cameraErrorMessage, cameraSide } from '../transfer/link.js';
import { packApp, installReceived, estimateSeconds, formatEstimate, TRANSFER_WARN } from '../transfer/pipeline.js';
import { formatBytes } from '../installer/install.js';
import { clean, NAME_MAX, DEFAULT_NAME } from '../installer/meta.js';
import { h, objectParticle } from './dialogs.js';

const INTRO_MS = 3000;
const CANCEL_SHOW_MS = 1000; // CANCEL 프레임을 보여주는 시간 (SPEC F-05 규칙 5)
const SENDER_LINGER_MS = 10_000; // 성공 후 RESULT를 더 보여주는 시간 (상대가 못 읽었을 수 있으므로)
const UI_INTERVAL = 250;

const FAIL_TEXT = {
  timeout: '❌ 연결이 끊겼어요',
  'hash-mismatch': '❌ 파일이 손상되었어요',
  decrypt: '❌ 파일이 손상되었어요',
  'peer-cancel': '상대방이 취소했습니다',
  'peer-verify-failed': '❌ 친구 쪽에서 파일이 손상되었어요',
  'bad-info': '❌ 받을 수 없는 앱 정보예요',
};

/** 상대가 보낸 이름은 C-5와 같이 다듬어 보여준다 (길이, 양방향 제어·폭 없는 문자) */
function peerAppName(info) {
  return info ? clean(info.name, NAME_MAX) : '';
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Toybox';
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
    const view = new TransferView({ ...o, onClose: resolve });
    view.start();
  });
}

class TransferView {
  #o;
  #root;
  #video;
  #canvas;
  #headline;
  #sub;
  #progress;
  #review;
  #actions;
  #intro;
  #session = null;
  #link = null;
  #offer = null;
  #uiTimer = 0;
  #closing = false;
  #installed = null;
  #installError = null;
  #installing = false;
  #lingerTimer = 0;
  #actionsKey = '';
  #prevFocus = null;
  #shell = null;
  #onResize = () => this.#layout();
  #onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.#cancelOrClose();
    }
  };

  constructor(o) {
    this.#o = o;
    this.#video = h('video', { class: 'tx-preview', playsinline: true, muted: true, 'aria-hidden': 'true' });
    this.#canvas = h('canvas', { class: 'tx-qr', role: 'img', 'aria-label': '전송용 QR 코드' });
    this.#headline = h('p', { class: 'tx-headline', 'aria-live': 'polite' });
    this.#sub = h('p', { class: 'tx-sub' });
    this.#progress = h('progress', { class: 'tx-progress', max: '1', value: '0', hidden: true });
    this.#review = h('div', { class: 'tx-review', hidden: true });
    this.#actions = h('div', { class: 'tx-actions' });
    this.#intro = h('div', { class: 'tx-intro', role: 'note' }, [
      h('p', { class: 'tx-intro-art', 'aria-hidden': 'true', text: '📱 ⇅ 📱' }),
      h('p', { text: '한 명은 폰을 거꾸로 들고, 화면끼리 마주 보게 15–25cm 거리에서 들어 주세요.' }),
      h('p', { class: 'tx-intro-sub', text: '화면 밝기를 최대로 하면 더 잘 읽혀요.' }),
    ]);
    this.#root = h('div', { class: 'transfer', role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-label': this.#o.role === ROLE.SENDER ? '앱 보내기' : 'QR로 받기' }, [
      h('div', { class: 'tx-status-half' }, [
        this.#video,
        h('div', { class: 'tx-status' }, [this.#headline, this.#sub, this.#progress, this.#review, this.#actions]),
      ]),
      h('div', { class: 'tx-qr-half' }, [this.#canvas]),
      this.#intro,
    ]);
  }

  async start() {
    // 모달: 뒤쪽 셸을 inert로 해 Tab·스크린 리더가 가려진 목록으로 가지 않게 하고, 닫으면 포커스를 돌려준다
    this.#prevFocus = document.activeElement;
    this.#shell = document.getElementById('shell');
    if (this.#shell) this.#shell.inert = true;
    document.body.append(this.#root);
    this.#root.focus();
    this.#layout();
    addEventListener('resize', this.#onResize);
    screen.orientation?.addEventListener?.('change', this.#onResize);
    document.addEventListener('keydown', this.#onKey);
    // 페이드 후 요소를 지운다 (보이지 않는 탭 등에서 transition이 끝나지 않아도 남지 않게)
    setTimeout(() => {
      this.#intro.classList.add('hidden');
      setTimeout(() => this.#intro.remove(), 500);
    }, INTRO_MS);
    await this.#begin();
  }

  /** 세션과 링크를 (다시) 만든다 */
  async #begin() {
    this.#installed = null;
    this.#installError = null;
    this.#installing = false;
    clearTimeout(this.#lingerTimer);
    this.#setStatus('준비하는 중…');
    this.#setActions([['취소', () => this.#close()]]);

    const { role, db, appId } = this.#o;
    try {
      if (role === ROLE.SENDER) this.#offer ??= await packApp(db, appId);
    } catch (err) {
      console.error(err);
      this.#setStatus('❌ 앱을 보낼 준비를 하지 못했어요', err.message);
      this.#setActions([['닫기', () => this.#close(), 'primary']]);
      return;
    }
    if (this.#closing) return;

    const session = new TransferSession({
      role,
      offer: this.#offer ?? undefined,
      deviceName: deviceName(),
      onChange: () => this.#render(),
    });
    await session.init();
    if (this.#closing) return;
    this.#session = session;
    // 권한 대기 중에 닫히거나 다시 시작될 수 있으므로 지역 변수로 잡아 둔다
    const link = new OpticalLink({ session, video: this.#video, canvas: this.#canvas });
    this.#link = link;
    this.#setStatus('📷 카메라 사용을 허용해 주세요', '상대의 화면을 읽으려면 카메라가 필요해요.');
    try {
      await link.start();
    } catch (err) {
      link.stop();
      if (this.#link !== link) return;
      this.#link = null;
      this.#setStatus('📷 카메라를 쓸 수 없어요', cameraErrorMessage(err));
      this.#setActions([['다시 시도', () => this.#retry()], ['닫기', () => this.#close(), 'primary']]);
      return;
    }
    if (this.#closing || this.#link !== link) {
      link.stop();
      return;
    }
    clearInterval(this.#uiTimer);
    this.#uiTimer = setInterval(() => this.#render(), UI_INTERVAL);
    this.#render();
  }

  #layout() {
    const side = cameraSide();
    this.#root.className = `transfer cam-${side}`;
    this.#link?.invalidate();
  }

  #setStatus(headline, sub = '') {
    this.#headline.textContent = headline;
    this.#sub.textContent = sub;
  }

  /** @param {[string, () => void, string?][]} list */
  #setActions(list) {
    const key = list.map(([label, , kind]) => `${label}:${kind ?? ''}`).join('|');
    if (key === this.#actionsKey) return;
    this.#actionsKey = key;
    this.#actions.replaceChildren(...list.map(([label, fn, kind]) => {
      const b = h('button', { type: 'button', class: `btn${kind ? ` btn-${kind}` : ''}`, text: label });
      b.addEventListener('click', fn);
      return b;
    }));
  }

  #render() {
    const s = this.#session;
    if (!s || this.#closing) return;
    const sum = s.summary();
    const sender = s.role === ROLE.SENDER;
    const name = sender ? this.#offer.name : peerAppName(s.info);
    const code = s.sas ? `연결됨 · 확인 코드 ${s.sas}` : '';
    const transferring = s.state === STATE.SENDING || s.state === STATE.RECEIVING;
    const STALL = '📐 화면을 다시 맞대 주세요';

    this.#progress.hidden = !transferring && s.state !== STATE.VERIFYING;
    this.#progress.value = sum.progress;
    this.#review.hidden = !(s.state === STATE.REVIEW);

    switch (s.state) {
      case STATE.ADVERTISING:
      case STATE.SCANNING:
        if (s.roleConflict) {
          this.#setStatus('⚠️ 상대도 같은 역할이에요', '한 명은 [전송하기], 다른 한 명은 [QR로 받기]를 선택하세요.');
        } else {
          this.#setStatus('🔍 친구의 폰을 찾는 중…', sender ? `‘${name}’${objectParticle(name)} 보낼 준비가 됐어요.` : '친구가 [전송하기]를 누르고 화면을 마주 보게 해 주세요.');
        }
        this.#setActions([['취소', () => this.#cancelOrClose()]]);
        return;
      case STATE.PAIRED:
        this.#setStatus(sum.stalled ? STALL : `🔗 ${code}`, sum.stalled ? code : '');
        this.#setActions([['취소', () => this.#cancelOrClose()]]);
        return;
      case STATE.OFFERING:
        this.#setStatus(sum.stalled ? STALL : '⏳ 친구의 수락을 기다리는 중', code);
        this.#setActions([['취소', () => this.#cancelOrClose()]]);
        return;
      case STATE.REVIEW:
        this.#setStatus(`🔗 ${code}`, '받을 앱을 확인하세요.');
        this.#renderReview(s);
        this.#setActions([]);
        return;
      case STATE.SENDING:
      case STATE.RECEIVING: {
        const pct = Math.floor(sum.progress * 100);
        const head = sum.stalled ? STALL : `${sender ? '📤' : '📥'} ${name} ${sender ? '보내는' : '받는'} 중 ${pct}%`;
        const speed = sum.bytesPerSec ? `${(sum.bytesPerSec / 1024).toFixed(1)} KB/s` : '';
        const eta = sum.etaSec != null ? `남은 시간 ${formatEstimate(sum.etaSec).replace('약 ', '')}` : '';
        const awake = this.#link?.wakeLockSupported ? '' : '화면이 꺼지지 않게 해 주세요.';
        this.#setStatus(head, [speed, eta, awake].filter(Boolean).join(' · '));
        this.#setActions([['취소', () => this.#cancelOrClose()]]);
        return;
      }
      case STATE.VERIFYING:
        this.#setStatus(sum.stalled ? STALL : '🔎 확인 중…', code);
        this.#setActions([['취소', () => this.#cancelOrClose()]]);
        return;
      case STATE.DONE:
        if (sender) {
          this.#setStatus('✅ 전송 성공!', '친구가 파일을 받았어요.');
          this.#setActions([['닫기', () => this.#close(), 'primary']]);
          this.#linger();
        } else {
          this.#onReceived(s);
        }
        return;
      case STATE.FAILED: {
        if (s.failReason === 'local-cancel') return; // #cancelOrClose가 닫는다
        this.#link?.stopCamera();
        this.#setStatus(FAIL_TEXT[s.failReason] ?? '❌ 전송하지 못했어요', s.failReason === 'timeout' ? '두 화면이 서로를 볼 수 있는지 확인해 주세요.' : '');
        this.#setActions([['다시 시도', () => this.#retry()], ['닫기', () => this.#close(), 'primary']]);
        clearInterval(this.#uiTimer);
        return;
      }
      default:
    }
  }

  #renderReview(s) {
    if (this.#review.dataset.ready) return;
    this.#review.dataset.ready = '1';
    const info = s.info;
    const secs = estimateSeconds(info.cipherSize);
    const big = info.cipherSize > TRANSFER_WARN;
    const start = h('button', { type: 'button', class: 'btn btn-primary', text: '전송 시작' });
    const reject = h('button', { type: 'button', class: 'btn', text: '거절' });
    start.addEventListener('click', () => {
      start.disabled = true;
      s.accept();
    });
    reject.addEventListener('click', () => this.#cancelOrClose());
    this.#review.replaceChildren(
      h('p', { class: 'tx-review-name', text: peerAppName(info) || DEFAULT_NAME }),
      h('p', { class: 'tx-review-meta', text: `파일 ${info.fileCount}개 · ${formatBytes(info.plainSize)}` }),
      h('p', { class: `tx-review-eta${big ? ' warn' : ''}`, text: `${formatEstimate(secs)} 소요 예상${big ? ' (큰 앱이라 오래 걸려요)' : ''}` }),
      h('div', { class: 'tx-actions' }, [reject, start]),
    );
    start.focus();
  }

  async #onReceived(s) {
    this.#link?.stopCamera();
    if (this.#installed) {
      // 확인창(W-06) 없이 설치하므로 실제 이름과 외부 리소스 경고(C-6)를 여기서 보여준다
      const ext = this.#installed.externalRefs ?? [];
      const warn = ext.length ? ` ⚠️ 이 앱은 인터넷의 파일을 사용해서(${ext.slice(0, 3).join(', ')}${ext.length > 3 ? ' 외' : ''}) 일부 기능이 동작하지 않을 수 있어요.` : '';
      this.#setStatus('✅ 설치 완료', `목록에 ‘${this.#installed.name}’ 앱을 추가했어요.${warn}`);
      this.#setActions([['닫기', () => this.#close()], ['바로 실행', () => this.#launch(), 'primary']]);
      return;
    }
    if (this.#installError) {
      this.#setStatus('❌ 설치할 수 없어요', this.#installError);
      this.#setActions([['닫기', () => this.#close(), 'primary']]);
      return;
    }
    if (this.#installing) return;
    this.#installing = true;
    this.#setStatus('📦 설치하는 중…');
    this.#setActions([]);
    try {
      this.#installed = await installReceived(this.#o.db, s.zip, s.info.name);
      this.#o.onInstalled?.(this.#installed);
    } catch (err) {
      console.error(err);
      this.#installError = err?.name === 'InstallError' ? err.message : '받은 앱을 설치하지 못했습니다.';
    }
    this.#installing = false;
    clearInterval(this.#uiTimer);
    this.#onReceived(s);
  }

  #linger() {
    if (this.#lingerTimer) return;
    this.#link?.stopCamera();
    this.#lingerTimer = setTimeout(() => {
      this.#link?.stop();
      clearInterval(this.#uiTimer);
    }, SENDER_LINGER_MS);
  }

  #launch() {
    const id = this.#installed?.id;
    this.#close();
    if (id) this.#o.onLaunch?.(id);
  }

  /** 진행 중이면 CANCEL을 1초 보여주고 닫는다. 끝났으면 바로 닫는다 */
  #cancelOrClose() {
    const s = this.#session;
    if (!s || s.finished) {
      this.#close();
      return;
    }
    s.cancel(CANCEL_REASON.USER);
    this.#setStatus('취소하는 중…');
    this.#setActions([]);
    setTimeout(() => this.#close(), CANCEL_SHOW_MS);
  }

  async #retry() {
    this.#teardown();
    this.#review.dataset.ready = '';
    this.#review.replaceChildren();
    this.#actionsKey = '';
    await this.#begin();
  }

  #teardown() {
    clearInterval(this.#uiTimer);
    clearTimeout(this.#lingerTimer);
    this.#lingerTimer = 0;
    this.#link?.stop();
    this.#link = null;
    this.#session = null;
  }

  #close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#teardown();
    removeEventListener('resize', this.#onResize);
    screen.orientation?.removeEventListener?.('change', this.#onResize);
    document.removeEventListener('keydown', this.#onKey);
    this.#root.remove();
    if (this.#shell) this.#shell.inert = false;
    if (this.#prevFocus?.isConnected) this.#prevFocus.focus();
    this.#o.onClose();
  }
}
