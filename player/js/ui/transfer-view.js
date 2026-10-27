// 맞대기 전송 화면 (F-05, W-14, W-15)
//   카메라에 가까운 절반은 스캔 카메라 칸, 먼 절반은 QR. 두 칸은 같은 크기로 구분선에 대칭이라
//   한 폰을 거꾸로 들고 마주 보면 내 QR이 상대의 카메라 칸에 겹친다. 송신과 수신이 같은 화면을 쓴다.
//   구분선이 진행 막대이고, 그 위에 안내(headline), 아래에 진행률·오류(sub)를 둔다.
//   앱이 제공한 이름은 textContent로만 넣는다.

import { TransferSession, ROLE, STATE, CANCEL_REASON, RTC } from '../transfer/session.js';
import { OpticalLink, cameraErrorMessage, cameraSide } from '../transfer/link.js';
import { RtcLink } from '../transfer/rtc-link.js';
import { packApp, installReceived, formatEstimate, TRANSFER_WARN } from '../transfer/pipeline.js';
import { clean, NAME_MAX, DEFAULT_NAME } from '../installer/meta.js';
import { formatBytes } from '../installer/install.js';
import { h, objectParticle } from './dialogs.js';

const INTRO_MS = 3000;
const CANCEL_SHOW_MS = 1000; // CANCEL 프레임을 보여주는 시간 (SPEC F-05 규칙 5)
const SENDER_LINGER_MS = 10_000; // 성공 후 RESULT를 더 보여주는 시간 (상대가 못 읽었을 수 있으므로)
const UI_INTERVAL = 250;

const FAIL_SUB = {
  timeout: '두 화면이 서로를 볼 수 있는지 확인해 주세요.',
  idle: '3분 동안 연결되지 않아 멈췄어요. 준비되면 [다시 시도]를 눌러 주세요.',
};

const FAIL_TEXT = {
  timeout: '❌ 연결이 끊겼어요',
  'hash-mismatch': '❌ 파일이 손상되었어요',
  decrypt: '❌ 파일이 손상되었어요',
  'peer-cancel': '상대방이 취소했습니다',
  'peer-verify-failed': '❌ 친구 쪽에서 파일이 손상되었어요',
  'peer-too-large': '❌ 친구가 받을 수 없는 앱이에요 (크기·파일 수 상한)',
  'bad-info': '❌ 받을 수 없는 앱 정보예요',
  idle: '⌛ 친구의 폰을 찾지 못했어요',
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
  return 'BeBeam';
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
  #bar;
  #fill;
  #panel;
  #detail;
  #actions;
  #intro;
  #session = null;
  #link = null;
  #rtc = null;
  #offer = null;
  #uiTimer = 0;
  #closing = false;
  #installed = null;
  #installError = null;
  #installing = false;
  #installApproved = false;
  #lingerTimer = 0;
  #actionsKey = '';
  #accepted = false;
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
    this.#fill = h('div', { class: 'tx-bar-fill' });
    this.#bar = h('div', { class: 'tx-bar', role: 'progressbar', 'aria-label': '전송 진행률', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, [this.#fill]);
    this.#actions = h('div', { class: 'tx-actions' });
    this.#detail = h('div', { class: 'tx-detail' });
    this.#panel = h('div', { class: 'tx-panel', hidden: true }, [this.#detail, this.#actions]);
    const close = h('button', { type: 'button', class: 'tx-close', 'aria-label': '취소', text: '✕' });
    close.addEventListener('click', () => this.#cancelOrClose());
    this.#intro = h('div', { class: 'tx-intro', role: 'note' }, [
      h('p', { class: 'tx-intro-art', 'aria-hidden': 'true', text: '📱 ⇅ 📱' }),
      h('p', { text: '한 명은 폰을 거꾸로 들고, 화면끼리 마주 보게 15–25cm 거리에서 들어 주세요.' }),
      h('p', { text: '내 QR이 친구 화면의 카메라 칸에 겹치게 맞추면 돼요.' }),
      h('p', { class: 'tx-intro-sub', text: '화면 밝기를 최대로 하면 더 잘 읽혀요.' }),
      h('p', { class: 'tx-intro-sub', text: '같은 Wi-Fi면 네트워크로 빠르게 보내요.' }),
    ]);
    this.#root = h('div', { class: 'transfer', role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-label': this.#o.role === ROLE.SENDER ? '앱 보내기' : 'QR로 받기' }, [
      h('div', { class: 'tx-cam-half' }, [h('div', { class: 'tx-square tx-cam-sq' }, [this.#video, this.#panel])]),
      h('div', { class: 'tx-band' }, [this.#headline, this.#bar, this.#sub]),
      h('div', { class: 'tx-qr-half' }, [h('div', { class: 'tx-square tx-qr-sq' }, [this.#canvas])]),
      close,
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
    this.#installApproved = false;
    clearTimeout(this.#lingerTimer);
    this.#setStatus('준비하는 중…');
    this.#setProgress(null);
    this.#setActions([]);

    // 키 교환(crypto.subtle)과 카메라(getUserMedia)는 보안 컨텍스트에서만 있다. http://내부IP로 열면 둘 다 없다
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
      this.#setStatus('🔒 이 주소에서는 전송할 수 없어요');
      this.#setActions([['닫기', () => this.#close(), 'primary']],
        ['카메라와 암호화는 https:// 주소에서만 동작해요.', '주소창이 https://로 시작하는 주소에서 플레이어를 열어 주세요.']);
      return;
    }

    const { role, db, appId } = this.#o;
    try {
      if (role === ROLE.SENDER) this.#offer ??= await packApp(db, appId);
    } catch (err) {
      console.error(err);
      this.#setStatus('❌ 앱을 보낼 준비를 하지 못했어요');
      this.#setActions([['닫기', () => this.#close(), 'primary']], err.message);
      return;
    }
    if (this.#closing) return;

    const session = new TransferSession({
      role,
      offer: this.#offer ?? undefined,
      deviceName: deviceName(),
      onChange: () => this.#render(),
      // 같은 내부망이면 QR과 함께 DataChannel로 보낸다. 묻지 않는다: 맞대어 짝지은 것이 동의다 (M5 D5.2)
      rtc: this.#rtc = new RtcLink(),
    });
    try {
      await session.init();
    } catch (err) {
      // 잡지 않으면 "준비하는 중…"에서 멈추고 카메라도 요청하지 않는다
      console.error(err);
      if (this.#closing) return;
      this.#setStatus('❌ 전송을 준비하지 못했어요');
      this.#setActions([['다시 시도', () => this.#retry()], ['닫기', () => this.#close(), 'primary']],
        '브라우저가 암호화 키를 만들지 못했어요. 다시 시도하거나 브라우저를 최신으로 바꿔 주세요.');
      return;
    }
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
      this.#setStatus('📷 카메라를 쓸 수 없어요');
      this.#setActions([['다시 시도', () => this.#retry()], ['닫기', () => this.#close(), 'primary']], cameraErrorMessage(err));
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

  /** 구분선 위 안내, 아래 진행률·오류. warn이면 아래 줄을 경고색으로 */
  #setStatus(headline, sub = '', warn = false) {
    this.#headline.textContent = headline;
    this.#sub.textContent = sub;
    this.#sub.classList.toggle('warn', warn);
  }

  /** @param {number | null} p 0–1, null이면 막대를 비운다 */
  #setProgress(p) {
    const pct = p == null ? 0 : Math.round(p * 100);
    this.#fill.style.width = `${pct}%`;
    this.#bar.setAttribute('aria-valuenow', String(pct));
    this.#bar.classList.toggle('active', p != null);
  }

  /**
   * 카메라가 꺼진 뒤의 버튼(다시 시도·닫기·바로 실행)은 카메라 칸 위에 띄운다. 취소는 모서리 ✕가 맡는다.
   * 구분선 아래 두 줄에 다 들어가지 않는 설명(detail)도 버튼 위에 함께 둔다.
   * @param {[string, () => void, string?][]} list
   * @param {string | string[]} [detail] 배열이면 한 줄씩, 첫 줄을 굵게. 문자열 안의 줄바꿈은 그대로 보인다
   * @param {{stack?: boolean}} [o] 버튼을 세로로 쌓는다
   */
  #setActions(list, detail = '', { stack = false } = {}) {
    this.#panel.hidden = list.length === 0;
    this.#actions.classList.toggle('stack', stack);
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
    const s = this.#session;
    if (!s || this.#closing) return;
    const sum = s.summary();
    const sender = s.role === ROLE.SENDER;
    const name = sender ? this.#offer.name : peerAppName(s.info) || DEFAULT_NAME;
    const code = s.sas ? `확인 코드 ${s.sas}` : '';
    const STALL = '📐 화면을 정확히 마주 보게 해 주세요';
    const PAUSED = '⏸ 일시 중지';

    switch (s.state) {
      case STATE.ADVERTISING:
      case STATE.SCANNING:
        this.#setProgress(null);
        if (s.roleConflict) {
          this.#setStatus('⚠️ 상대도 같은 역할이에요', '한 명은 [전송하기], 다른 한 명은 [QR로 받기]를 선택하세요.', true);
        } else {
          this.#setStatus('🔍 친구의 폰을 찾는 중…', sender ? `‘${name}’${objectParticle(name)} 보낼 준비가 됐어요.` : '친구가 [전송하기]를 누르고 화면을 마주 보게 해 주세요.');
        }
        this.#setActions([]);
        return;
      case STATE.PAIRED:
      case STATE.OFFERING:
        this.#setProgress(0);
        this.#setStatus(sum.stalled ? PAUSED : `🔗 연결됨 · ${code}`, sum.stalled ? STALL : '곧 전송을 시작해요.', sum.stalled);
        this.#setActions([]);
        return;
      case STATE.REVIEW:
        // 암호를 주고받았으면 바로 받는다 ([전송 시작] 없음, SPEC F-05 규칙 3)
        if (!this.#accepted) {
          this.#accepted = true;
          s.accept();
        }
        this.#setProgress(0);
        this.#setStatus(`🔗 연결됨 · ${code}`, '곧 전송을 시작해요.');
        this.#setActions([]);
        return;
      case STATE.SENDING:
      case STATE.RECEIVING: {
        const pct = Math.floor(sum.progress * 100);
        this.#setProgress(sum.progress);
        if (sum.stalled) {
          this.#setStatus(`${PAUSED} · ${name}`, `${pct}% · ${STALL}`, true);
        } else {
          const kbs = sum.bytesPerSec / 1024;
          const speed = !sum.bytesPerSec ? '' : kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(1)} KB/s`;
          // 지금 경로 (M5): 내부망으로 보내는 중이면 ⚡, 내부망이 끊겨 QR로 이어 가면 📷. 처음부터 QR이면 표시하지 않는다
          const path = sum.rtc === RTC.OPEN && !sum.rtcStalled ? '⚡ Wi-Fi' : s.rtcOpened ? '📷 QR로 계속' : '';
          const eta = sum.etaSec != null ? `남은 시간 ${formatEstimate(sum.etaSec).replace('약 ', '')}` : '';
          const big = !sender && s.info?.cipherSize > TRANSFER_WARN && !(sum.rtc === RTC.OPEN && !sum.rtcStalled) ? '큰 앱이라 오래 걸려요' : '';
          const awake = this.#link?.wakeLockSupported ? '' : '화면이 꺼지지 않게 해 주세요';
          this.#setStatus(`${sender ? '📤' : '📥'} ‘${name}’ ${sender ? '보내는' : '받는'} 중`, [`${pct}%`, speed, eta, big, awake, path].filter(Boolean).join(' · '));
        }
        this.#setActions([]);
        return;
      }
      case STATE.VERIFYING:
        this.#setProgress(1);
        this.#setStatus(sum.stalled ? PAUSED : '🔎 확인 중…', sum.stalled ? STALL : '100%', sum.stalled);
        this.#setActions([]);
        return;
      case STATE.DONE:
        this.#setProgress(1);
        if (sender) {
          this.#setStatus('✅ 전송 성공!', '친구가 파일을 받았어요.');
          // 같은 앱을 다음 친구에게: [전송준비]는 새 키·세션으로 다시 HELLO를 띄운다 (묶은 앱은 재사용)
          this.#setActions([['전송준비', () => this.#retry(), 'primary'], ['완료', () => this.#close()]],
            '이 앱을 다른 친구에게도\n전송할까요?', { stack: true });
          this.#linger();
        } else {
          this.#onReceived(s);
        }
        return;
      case STATE.FAILED: {
        if (s.failReason === 'local-cancel') return; // #cancelOrClose가 닫는다
        this.#link?.stopCamera();
        this.#setProgress(null);
        this.#setStatus(FAIL_TEXT[s.failReason] ?? '❌ 전송하지 못했어요', FAIL_SUB[s.failReason] ?? '', true);
        this.#setActions([['다시 시도', () => this.#retry()], ['닫기', () => this.#close(), 'primary']]);
        clearInterval(this.#uiTimer);
        return;
      }
      default:
    }
  }

  async #onReceived(s) {
    this.#link?.stopCamera();
    if (this.#installed) {
      // W-06 대신 이 화면에서 설치 동의를 받았으므로 실제 이름과 외부 리소스 경고(C-6)는 설치 뒤 여기서 보여준다
      const ext = this.#installed.externalRefs ?? [];
      const warn = ext.length ? `⚠️ 이 앱은 인터넷의 파일을 사용해서(${ext.slice(0, 3).join(', ')}${ext.length > 3 ? ' 외' : ''}) 일부 기능이 동작하지 않을 수 있어요.` : '';
      this.#setStatus('✅ 설치 완료', `목록에 ‘${this.#installed.name}’ 앱을 추가했어요.`);
      this.#setActions([['닫기', () => this.#close()], ['바로 실행', () => this.#launch(), 'primary']], warn);
      return;
    }
    if (this.#installError) {
      this.#setStatus('❌ 설치할 수 없어요');
      this.#setActions([['닫기', () => this.#close(), 'primary']], this.#installError);
      return;
    }
    if (this.#installing) return;
    if (!this.#installApproved) {
      // 전송은 버튼 없이 진행하지만 설치는 받은 앱을 다시 보여주고 동의를 받는다 (T11)
      const info = s.info;
      this.#setStatus('📦 전송이 끝났어요. 설치를 시작할까요?', s.sas ? `확인 코드 ${s.sas} · 친구 화면과 같은지 확인하세요` : '');
      this.#setActions([['취소', () => this.#close()], ['설치 시작', () => this.#approveInstall(s), 'primary']], [
        peerAppName(info) || DEFAULT_NAME,
        `파일 ${info.fileCount}개 · ${formatBytes(info.plainSize)}`,
      ]);
      return;
    }
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

  #approveInstall(s) {
    if (this.#installApproved || this.#closing) return;
    this.#installApproved = true;
    this.#onReceived(s);
  }

  #linger() {
    if (this.#lingerTimer) return;
    this.#link?.stopCamera();
    this.#lingerTimer = setTimeout(() => {
      this.#link?.stop();
      this.#rtc?.close();
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
    this.#accepted = false;
    this.#actionsKey = '';
    await this.#begin();
  }

  #teardown() {
    clearInterval(this.#uiTimer);
    clearTimeout(this.#lingerTimer);
    this.#lingerTimer = 0;
    this.#link?.stop();
    this.#link = null;
    this.#rtc?.close();
    this.#rtc = null;
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
