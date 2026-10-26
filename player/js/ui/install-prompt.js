// 플레이어 설치 유도와 저장소 유지 요청 (SPEC F-01 3–4, W-02, W-03)
//   Chrome/Edge/Android: beforeinstallprompt → 상단 배너 [나중에](7일 숨김) [설치]
//   iOS(standalone 아님): 홈 화면 추가 안내 [다시 보지 않기] [확인]
//   이미 standalone이면 아무것도 띄우지 않는다.
//   navigator.storage.persist()는 처음 한 번 요청하고 결과를 meta.settings.persisted에 기록한다.

import { getMeta, setMeta } from '../db.js';
import { h, openDialog } from './dialogs.js';

export const DISMISSED_KEY = 'toybox.ui.installPromptDismissedAt';
export const IOS_HIDDEN_KEY = 'toybox.ui.iosGuideHidden';
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** iPhone/iPad (iPadOS는 데스크톱 Safari처럼 Mac으로 보이므로 터치 지점 수로 구별) */
export function isIos({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/** 설치 배너를 띄울지: standalone이 아니고, [나중에]를 누른 지 7일이 지났거나 누른 적 없음 */
export function shouldOfferInstall({ standalone, dismissedAt, now }) {
  if (standalone) return false;
  const t = Number(dismissedAt);
  return !Number.isFinite(t) || t <= 0 || now - t >= SNOOZE_MS;
}

/** iOS 안내를 띄울지 */
export function shouldShowIosGuide({ ios, standalone, hidden }) {
  return ios && !standalone && !hidden;
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key) {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    storage()?.setItem(key, value);
  } catch {}
}

/**
 * 설치 유도를 시작한다. beforeinstallprompt는 일찍 올 수 있으므로 DB를 열기 전에 부른다.
 * @param {{banner: HTMLElement}} o 배너를 넣을 자리 (셸 상단, 목록을 가리지 않는 grid 행)
 * @returns {{onInstalled: (fn: () => void) => void}}
 */
export function setupInstallPrompt({ banner }) {
  let deferred = null;
  const installedHandlers = [];

  const hide = () => {
    banner.hidden = true;
    banner.replaceChildren();
  };

  const show = () => {
    const later = h('button', { type: 'button', class: 'btn', text: '나중에' });
    const install = h('button', { type: 'button', class: 'btn btn-primary', text: '설치' });
    later.addEventListener('click', () => {
      write(DISMISSED_KEY, String(Date.now()));
      hide();
    });
    install.addEventListener('click', async () => {
      const e = deferred;
      deferred = null;
      hide();
      if (!e) return;
      try {
        await e.prompt();
        await e.userChoice;
      } catch (err) {
        console.warn(err);
      }
    });
    banner.replaceChildren(
      h('p', { class: 'install-banner-text', text: '📲 Toybox를 설치하면 오프라인에서도 바로 실행할 수 있어요.' }),
      h('div', { class: 'install-banner-actions' }, [later, install]),
    );
    banner.hidden = false;
  };

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 브라우저 기본 미니 인포바 대신 W-02 배너
    deferred = e;
    if (shouldOfferInstall({ standalone: isStandalone(), dismissedAt: read(DISMISSED_KEY), now: Date.now() })) show();
  });

  addEventListener('appinstalled', () => {
    deferred = null;
    hide();
    for (const fn of installedHandlers) fn();
  });

  return { onInstalled: (fn) => installedHandlers.push(fn) };
}

/** iOS 홈 화면 추가 안내 (W-03). 조건이 맞을 때만 연다 */
export async function maybeShowIosGuide() {
  const ios = isIos(navigator);
  if (!shouldShowIosGuide({ ios, standalone: isStandalone(), hidden: read(IOS_HIDDEN_KEY) === '1' })) return;
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  const { value } = await openDialog({
    title: '홈 화면에 추가하기',
    className: `ios-guide${iphone ? ' ios-guide-bottom' : ''}`,
    body: [
      h('ol', { class: 'ios-guide-steps' }, [
        h('li', { text: `${iphone ? '하단' : '상단'}의 [ 공유 ] 버튼` }),
        h('li', { text: '[ 홈 화면에 추가 ]' }),
        h('li', { text: '[ 추가 ]' }),
      ]),
      h('p', { class: 'dialog-message', text: '홈 화면에서 실행해야 앱이 지워지지 않고 전체 화면으로 실행돼요.' }),
    ],
    buttons: [
      { label: '다시 보지 않기', value: 'never' },
      { label: '확인', value: 'ok', kind: 'primary', autofocus: true },
    ],
  });
  if (value === 'never') write(IOS_HIDDEN_KEY, '1');
}

/**
 * 저장소 유지 요청 (SPEC F-01 4). 아직 요청한 적이 없거나 force일 때만 persist()를 부른다
 * (Firefox는 요청할 때마다 권한 창을 띄우므로 매번 부르지 않는다). 결과는 meta.settings.persisted.
 */
export async function requestPersistence(db, { force = false } = {}) {
  const sm = navigator.storage;
  if (!sm?.persist) return;
  try {
    const settings = (await getMeta(db, 'settings')) ?? {};
    let persisted = await sm.persisted();
    if (!persisted && (force || settings.persisted === undefined)) persisted = await sm.persist();
    if (settings.persisted !== persisted) await setMeta(db, 'settings', { ...settings, persisted });
  } catch (err) {
    console.warn('저장소 유지 요청 실패', err);
  }
}
