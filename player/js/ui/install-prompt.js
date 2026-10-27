// 플레이어 설치 유도와 저장소 유지 요청 (SPEC F-01 3–4, W-02, W-03)
//   Chrome/Edge/Android: beforeinstallprompt → 상단 배너 [나중에](7일 숨김) [설치]
//   설치 안내(W-03): iOS는 처음 한 번 자동으로, 그 뒤에는 목록 아래 "(?) 설치안내"로 연다. 기기별 단계를 보여준다
//   이미 standalone이면 아무것도 띄우지 않는다.
//   navigator.storage.persist()는 처음 한 번 요청하고 결과를 meta.settings.persisted에 기록한다.

import { getMeta, setMeta } from '../db.js';
import { h, openDialog } from './dialogs.js';

export const DISMISSED_KEY = 'toybox.ui.installPromptDismissedAt';
export const IOS_SHOWN_KEY = 'toybox.ui.iosGuideShown';
/** v1.3 전의 [다시 보지 않기]. 눌렀던 사용자는 안내를 본 것으로 친다 */
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

/** iOS 안내를 자동으로 띄울지: 처음 한 번만 (그 뒤에는 "(?) 설치안내") */
export function shouldShowIosGuide({ ios, standalone, shown }) {
  return ios && !standalone && !shown;
}

export function isStandalone() {
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

  return {
    onInstalled: (fn) => installedHandlers.push(fn),
    /** "(?) 설치안내": 받아 둔 설치 창이 있으면 [설치]도 함께 */
    openGuide: () => openInstallGuide({
      deferred,
      onInstall: () => {
        const e = deferred;
        deferred = null;
        hide();
        return e?.prompt().then(() => e.userChoice).catch((err) => console.warn(err));
      },
    }),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 안내 단계에 넣는 작은 아이콘 (브라우저 UI 모양을 흉내 낸 선 그림) */
function icon(kind, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'guide-icon');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const paths = {
    share: ['M8 10H6v10h12V10h-2', 'M12 3v12', 'M8.5 6.5 12 3l3.5 3.5'],
    more: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M7.5 12h.01', 'M12 12h.01', 'M16.5 12h.01'],
    add: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M12 8v8', 'M8 12h8'],
  }[kind];
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** 한 단계: 아이콘과 글을 한 줄에 */
const step = (...parts) => h('li', {}, parts);

/**
 * 설치 안내 (W-03). iOS는 Safari·Chrome 공용 3단계, 그 밖에는 브라우저의 설치 메뉴를 안내한다.
 * @param {{deferred?: object | null, onInstall?: () => void}} [o]
 */
export async function openInstallGuide({ deferred = null, onInstall } = {}) {
  const ios = isIos(navigator);
  const body = ios
    ? [
      h('ol', { class: 'ios-guide-steps' }, [
        step('주소표시줄 옆 메뉴의 ', icon('share', '공유'), ' 공유 누르기'),
        step(icon('more', '더보기'), ' 더보기 메뉴 펼치기'),
        step(icon('add', '추가'), ' 홈 화면에 추가'),
      ]),
      h('p', { class: 'dialog-message', text: '홈 화면에서 실행해야 앱이 지워지지 않고 전체 화면으로 실행돼요.' }),
    ]
    : [
      h('ol', { class: 'ios-guide-steps' }, [
        step('주소표시줄 오른쪽의 설치 아이콘을 누르거나'),
        step('브라우저 메뉴(⋮)에서 [앱 설치] 또는 [홈 화면에 추가]'),
      ]),
      h('p', { class: 'dialog-message', text: '설치하면 오프라인에서도 바로 실행할 수 있어요.' }),
    ];
  const buttons = [{ label: '확인', value: 'ok', kind: deferred ? '' : 'primary', autofocus: !deferred }];
  if (deferred && !ios) buttons.unshift({ label: '설치', value: 'install', kind: 'primary', autofocus: true });
  const { value } = await openDialog({ title: '홈 화면에 추가하기', className: 'ios-guide', body, buttons });
  if (value === 'install') onInstall?.();
}

/** iOS 홈 화면 추가 안내 (W-03). 처음 한 번만 자동으로 연다 */
export async function maybeShowIosGuide() {
  const ios = isIos(navigator);
  const shown = read(IOS_SHOWN_KEY) === '1' || read(IOS_HIDDEN_KEY) === '1';
  if (!shouldShowIosGuide({ ios, standalone: isStandalone(), shown })) return;
  write(IOS_SHOWN_KEY, '1');
  await openInstallGuide();
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
