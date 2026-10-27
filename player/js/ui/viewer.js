// 뷰어와 실행 모드 (F-04, W-08~W-10)
//   상태: (a) 선택 없음 (b) ▶ (og:image가 있으면 배경) (c) 오류 + [앱 삭제]
//   실행: requestFullscreen(미지원이면 CSS 전체화면) → 목록·헤더 숨김 → sandbox iframe 부팅 → [X]
//   종료 확인: [X], Esc/전체화면 해제, Android 뒤로가기(history 가드)

import { loadForRun, applyStorageBatch, touchLastRun, savePlan, saveOgImage, request } from '../db.js';
import { AppRun, preflight } from '../runtime/host.js';
import { replan, findInstalledOgImage } from '../installer/install.js';
import { h, confirmDialog } from './dialogs.js';
import { iconUrl } from './list.js';

const HISTORY_KEY = 'bebeam:running';
const NAV_MESSAGE = '앱이 허용되지 않은 동작을 시도해 종료되었습니다.';

export class Viewer {
  #el;
  #hint;
  #db = null;
  #store;
  #onDelete;
  /** appId → 마지막 실행 오류 {message, logs} (새로고침하면 사라진다) */
  #errors = new Map();
  #run = null;
  #runId = null;
  #cssFullscreen = false;
  #confirming = false;
  #exiting = false;
  /** 뷰어 배경 캐시 {key: 'appId\0path', url, revoke} */
  #bg = null;

  /**
   * @param {HTMLElement} el 뷰어 영역
   * @param {{store: import('../store.js').Store, onDelete: (id: string) => void}} options
   */
  constructor(el, { store, onDelete }) {
    this.#el = el;
    this.#hint = el.querySelector('#viewer-hint');
    this.#store = store;
    this.#onDelete = onDelete;

    document.addEventListener('fullscreenchange', () => this.#onFullscreenChange());
    document.addEventListener('webkitfullscreenchange', () => this.#onFullscreenChange());
    addEventListener('popstate', () => this.#onPopState());
    document.addEventListener('keydown', (e) => {
      // CSS 전체화면일 때 Esc (iframe 안에 포커스가 있으면 플레이어로 오지 않는다)
      if (e.key === 'Escape' && this.#run && this.#cssFullscreen && !this.#confirming) {
        e.preventDefault();
        this.#askExit();
      }
    });
  }

  setDb(db) {
    this.#db = db;
  }

  get running() {
    return this.#run !== null;
  }

  /** 선택 상태 렌더링 (W-08) */
  render(app) {
    if (this.#run) return;
    if (!app) {
      this.#dropBackground();
      this.#el.replaceChildren(this.#hint);
      this.#hint.hidden = false;
      return;
    }
    this.#hint.hidden = true;
    const err = this.#errors.get(app.id) ?? (app.status === 'broken' ? { message: app.error || '앱을 실행할 수 없습니다.' } : null);
    if (err) {
      this.#dropBackground();
      const details = err.logs?.length
        ? h('details', { class: 'viewer-logs' }, [h('summary', { text: '자세히 (앱이 보고한 메시지 포함)' }), h('pre', { text: err.logs.join('\n') })])
        : '';
      const del = h('button', { type: 'button', class: 'btn btn-danger', text: '앱 삭제' });
      del.addEventListener('click', () => this.#onDelete(app.id));
      const retry = h('button', { type: 'button', class: 'btn', text: '다시 실행' });
      retry.addEventListener('click', () => {
        this.#errors.delete(app.id);
        this.play(app.id);
      });
      this.#el.replaceChildren(this.#hint, h('div', { class: 'viewer-card viewer-error', role: 'alert' }, [
        h('p', { class: 'viewer-error-icon', 'aria-hidden': 'true', text: '⚠️' }),
        h('p', { class: 'viewer-error-title', text: '앱을 실행할 수 없습니다.' }),
        h('p', { class: 'viewer-error-message', text: err.message }),
        details,
        h('div', { class: 'viewer-actions' }, [retry, del]),
      ]));
      return;
    }
    const play = h('button', { type: 'button', class: 'play-button', 'aria-label': `${app.name} 실행`, text: '▶' });
    play.addEventListener('click', () => this.play(app.id));
    const bg = h('img', { class: 'viewer-bg', alt: '', draggable: 'false', hidden: true });
    this.#el.replaceChildren(this.#hint, bg, h('div', { class: 'viewer-card' }, [
      play,
      h('p', { class: 'viewer-name', text: app.name }),
    ]));
    this.#paintBackground(app, bg).catch((err) => console.warn('뷰어 배경', err));
  }

  /** og:image를 ▶ 뒤 배경으로 (W-08 b). 아이콘과 같이 iconUrl()을 거쳐 <img>에만 넣는다 (T8) */
  async #paintBackground(app, img) {
    const db = this.#db;
    if (!db) return;
    let path = app.ogImagePath;
    if (path === undefined) {
      // 이 필드가 생기기 전에 설치된 앱: 한 번 찾아 저장한다 (없으면 null)
      path = await findInstalledOgImage(db, app).catch(() => null);
      app.ogImagePath = path;
      await saveOgImage(db, app.id, path).catch(() => {});
    }
    if (!path) {
      this.#dropBackground();
      return;
    }
    const key = `${app.id}\0${path}`;
    if (this.#bg?.key !== key) {
      this.#dropBackground();
      const entry = { key, url: null, revoke: () => {}, pending: null };
      this.#bg = entry;
      entry.pending = request(db.transaction('files').objectStore('files').get([app.id, path]))
        .then((file) => (file?.blob ? iconUrl(file.blob, file.mime) : null))
        .then((u) => {
          if (!u) return;
          if (this.#bg !== entry) {
            u.revoke();
            return;
          }
          entry.url = u.url;
          entry.revoke = u.revoke;
        });
    }
    const entry = this.#bg;
    await entry.pending;
    // 그 사이 다른 앱을 골랐거나 실행했으면 img가 화면에서 빠져 있다
    if (this.#bg !== entry || !entry.url || !img.isConnected) return;
    img.src = entry.url;
    img.hidden = false;
  }

  #dropBackground() {
    this.#bg?.revoke();
    this.#bg = null;
  }

  clearError(id) {
    this.#errors.delete(id);
  }

  /** ▶ (F-04 실행 1–4). 사용자 제스처 안에서 불러야 전체화면이 된다 */
  async play(id) {
    if (this.#run || !this.#db) return;
    const app = this.#store.state.apps.find((a) => a.id === id);
    if (!app) return;

    // 전체화면은 제스처가 살아 있을 때 먼저 요청한다 (DB 읽기 등 await 전에)
    const fs = this.#enterFullscreen();
    this.#store.setScreen('running');
    history.pushState({ [HISTORY_KEY]: true }, '');

    const closeBtn = h('button', { type: 'button', class: 'run-close', 'aria-label': '앱 종료', text: '✕' });
    closeBtn.addEventListener('click', () => this.#askExit());
    const stage = h('div', { class: 'run-stage' });
    const loading = h('p', { class: 'run-loading', text: '여는 중…' });
    this.#el.replaceChildren(stage, loading, closeBtn);
    this.#runId = id;
    // 부팅 중에도 running으로 본다. 그 사이 종료하면 토큰이 바뀌므로 이후 단계를 멈춘다
    const token = { pending: true };
    this.#run = token;
    const cancelled = () => this.#run !== token;

    try {
      await fs;
      if (cancelled()) return;
      const data = await loadForRun(this.#db, id);
      if (cancelled()) return;
      if (!data) throw Object.assign(new Error('앱을 찾을 수 없습니다.'), { reason: 'missing' });
      let plan = data.app.rewritePlan;
      const check = preflight(data.app);
      if (check.needsReplan) {
        plan = await replan(data.files);
        if (cancelled()) return;
        await savePlan(this.#db, id, plan);
        const again = preflight({ ...data.app, rewritePlan: plan });
        if (again.error) throw new Error(again.error);
      } else if (check.error) {
        throw new Error(check.error);
      }

      const run = new AppRun({
        container: stage,
        files: data.files,
        plan,
        entry: data.app.entry,
        storage: data.storage,
        onStorage: (batch) => applyStorageBatch(this.#db, id, batch),
        onExit: (info) => this.#onRunExit(id, info),
      });
      if (cancelled()) return;
      this.#run = run;
      await run.start();
      if (this.#run !== run) return;
      loading.remove();
      const updated = await touchLastRun(this.#db, id);
      if (updated) this.#store.upsertApp(updated);
    } catch (err) {
      // 부팅 실패: 실행 모드를 풀고 오류 상태로 (F-04 5). 사용자가 이미 종료했으면 무시
      if (this.#runId !== id || this.#exiting) return;
      this.#errors.set(id, { message: err.message || '앱을 시작하지 못했습니다.', logs: err.logs ?? [] });
      await this.#leave();
    }
  }

  /** 종료 확인 (W-10). 기본 포커스는 [계속하기] */
  async #askExit() {
    if (!this.#run || this.#confirming || this.#exiting) return;
    this.#confirming = true;
    const ok = await confirmDialog({ title: '앱을 종료할까요?', confirmLabel: '종료', cancelLabel: '계속하기' });
    this.#confirming = false;
    if (!this.#run) return;
    if (ok) {
      await this.exit();
    } else if (!this.#isFullscreen() && !this.#cssFullscreen) {
      // Esc로 전체화면이 풀린 뒤 [계속하기]: 다시 전체화면으로 (버튼 클릭 제스처 안)
      await this.#enterFullscreen();
    }
  }

  /** 종료: flush(최대 500ms) → iframe 제거 → 전체화면 해제 → 목록 복원 */
  async exit() {
    if (!this.#run || this.#exiting) return;
    this.#exiting = true;
    try {
      if (this.#run instanceof AppRun) await this.#run.close();
    } finally {
      await this.#leave();
      this.#exiting = false;
    }
  }

  #onRunExit(id, info) {
    if (info.reason === 'closed') return;
    // 부팅 전 실패는 play()의 catch가 처리한다
    if (info.reason === 'boot-timeout' || info.reason === 'boot-error') return;
    this.#errors.set(id, {
      message: info.reason === 'navigation' ? NAV_MESSAGE : info.message || '앱이 종료되었습니다.',
      logs: info.logs,
    });
    this.#leave();
  }

  async #leave() {
    const id = this.#runId;
    this.#run = null;
    this.#runId = null;
    this.#el.querySelector('.app-frame')?.remove();
    if (this.#isFullscreen()) {
      try {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      } catch {}
    }
    this.#setCssFullscreen(false);
    if (history.state?.[HISTORY_KEY]) history.back();
    this.#store.setScreen('home');
    this.render(this.#store.state.apps.find((a) => a.id === id) ?? this.#store.selectedApp);
    this.#el.querySelector('.play-button, .viewer-actions .btn')?.focus();
  }

  #isFullscreen() {
    return !!(document.fullscreenElement ?? document.webkitFullscreenElement);
  }

  /** Fullscreen API를 먼저 쓰고, 미지원·실패면 CSS 전체화면 (iPhone 등) */
  async #enterFullscreen() {
    const el = this.#el;
    const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (request) {
      try {
        await request.call(el, { navigationUI: 'hide' });
        this.#setCssFullscreen(false);
        // 회전 고정 풀기 (지원 기기만)
        try {
          screen.orientation?.unlock?.();
        } catch {}
        return;
      } catch {
        // 제스처가 없거나 거부됨 → CSS로
      }
    }
    this.#setCssFullscreen(true);
  }

  #setCssFullscreen(on) {
    this.#cssFullscreen = on;
    this.#el.classList.toggle('css-fullscreen', on);
  }

  #onFullscreenChange() {
    if (!this.#run || this.#exiting) return;
    const fsEl = document.fullscreenElement ?? document.webkitFullscreenElement;
    if (fsEl && fsEl !== this.#el) {
      // 앱(iframe)이 스스로 전체화면을 잡으면 top layer로 올라가 [X]를 가린다 (T4).
      // 플레이어의 CSS 전체화면으로 바꾸고 전체화면을 푼다 ([X]가 다시 위에 온다)
      this.#setCssFullscreen(true);
      try {
        document.exitFullscreen?.() ?? document.webkitExitFullscreen?.();
      } catch {}
      return;
    }
    // 사용자가 Esc 등으로 전체화면을 빠져나감 → 종료 확인 (F-04 4)
    if (!fsEl && !this.#cssFullscreen) this.#askExit();
  }

  #onPopState() {
    // Android 뒤로가기: 가드를 다시 세우고 종료 확인
    if (!this.#run || this.#exiting) return;
    history.pushState({ [HISTORY_KEY]: true }, '');
    this.#askExit();
  }
}
