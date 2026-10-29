// 플레이어 설치 유도와 저장소 유지 요청 (SPEC F-01 3–4, W-02, W-03)
//   Chrome/Edge/Android: beforeinstallprompt → 상단 배너 [나중에](7일 숨김) [설치]
//   목록 아래 [비빔 앱 설치하기]: 받아 둔 설치 창이 있으면 바로 띄우고, 없으면 설치 안내(W-03)를 연다.
//   iOS·macOS Safari는 브라우저 탭과 설치한 웹앱(홈 화면·Dock)의 저장소가 따로라서, 설치해서 열지 않으면 셸 대신 막는 화면(W-03)만 보인다.
//   이미 standalone이면 아무것도 띄우지 않는다.
//   navigator.storage.persist()는 처음 한 번 요청하고 결과를 meta.settings.persisted에 기록한다.

import { getMeta, setMeta } from '../db.js';
import { h, openDialog } from './dialogs.js';
import { icon as lineIcon } from './icons.js';
import { renderQR } from '../transfer/qr.js';

export const DISMISSED_KEY = 'bebeam.ui.installPromptDismissedAt';
/** 설치한 앱 창을 여는 주소. manifest protocol_handlers로 설치한 앱에 등록된다 (컴퓨터 Chrome·Edge) */
export const OPEN_APP_URL = 'web+bebeam://open';
/** 설치 이벤트(beforeinstallprompt)를 기다리는 시간. 이 안에 오지 않으면 설치한 것으로 본다 */
export const OFFER_WAIT_MS = 2000;
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** 비빔 사이트: 처음 받는 사람 안내(보낼 준비)와 iOS 설치 안내의 작은 QR */
export const SITE_URL = 'https://www.bebeam.net/';
export const SITE_LABEL = 'www.bebeam.net';
// renderQR은 Alphanumeric 모드라 대문자로 넣는다 (스킴·호스트는 대소문자를 가리지 않는다)
const SITE_QR_TEXT = SITE_URL.toUpperCase();

/** 사이트 QR을 canvas에 그린다. canvas는 화면에 붙어 CSS 크기가 정해진 뒤여야 한다 */
export function drawSiteQr(canvas) {
  renderQR(canvas, SITE_QR_TEXT, 'M');
}

/** iPhone/iPad (iPadOS는 데스크톱 Safari처럼 Mac으로 보이므로 터치 지점 수로 구별). assets/landing.js에 같은 규칙이 있다 */
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

/**
 * macOS의 Safari (Dock에 추가로 웹앱을 만든다). Safari를 흉내 내는 Chrome·Edge·Firefox·Opera는 뺀다.
 * assets/landing.js에 같은 규칙이 있다
 */
export function isMacSafari({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (isIos({ userAgent, platform, maxTouchPoints })) return false;
  return /Macintosh/.test(userAgent) && /Version\/[\d.]+.* Safari\//.test(userAgent) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(userAgent);
}

/**
 * 설치해서 열지 않았으면 막는 화면의 종류: 'ios'(홈 화면) | 'mac'(Dock) | null.
 * 브라우저 탭에서 설치한 앱은 설치한 웹앱에 보이지 않으므로 탭에서는 시작하지 않는다
 */
export function installGate({ ios, macSafari, standalone }) {
  if (standalone) return null;
  if (ios) return 'ios';
  if (macSafari) return 'mac';
  return null;
}

/**
 * 설치한 앱 창의 display-mode. 데스크톱에서는 standalone만 보면 안 된다:
 * macOS 전체 화면이면 fullscreen, 제목 표시줄을 접으면 window-controls-overlay가 된다
 */
export const INSTALLED_DISPLAY_QUERY = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
  .map((m) => `(display-mode: ${m})`).join(', ');

export function isStandalone() {
  return matchMedia(INSTALLED_DISPLAY_QUERY).matches || navigator.standalone === true;
}

/**
 * 목록 아래에 보일 것: 'install' [비빔 앱 설치하기] | 'open' [앱으로 열기] | 'link' 사이트 링크.
 * Chromium은 이미 설치한 앱이면 브라우저 탭에서도 beforeinstallprompt를 보내지 않으므로, 이벤트가 없으면 설치한 것으로 보고
 * [앱으로 열기]를 보인다(protocol_handlers는 컴퓨터만 되므로 Android는 링크). 이벤트가 없는 브라우저(Firefox 등)는 설치 안내를 연다
 */
export function libraryAction({ installed, promptSupported, offered, android }) {
  if (installed) return 'link';
  if (!promptSupported || offered) return 'install';
  return android ? 'link' : 'open';
}

/** 창 모드가 바뀌면(전체 화면 들어가기·나오기 등) 부른다 */
export function onDisplayModeChange(fn) {
  matchMedia(INSTALLED_DISPLAY_QUERY).addEventListener('change', fn);
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
  let offered = false; // 이 페이지에서 beforeinstallprompt를 받았다 = 아직 설치하지 않았다
  const installedHandlers = [];
  const offeredHandlers = [];

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
      h('p', { class: 'install-banner-text' }, [lineIcon('download'), 'BeBeam을 설치하면 오프라인에서도 바로 실행할 수 있어요.']),
      h('div', { class: 'install-banner-actions' }, [later, install]),
    );
    banner.hidden = false;
  };

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 브라우저 기본 미니 인포바 대신 W-02 배너
    deferred = e;
    offered = true;
    for (const fn of offeredHandlers) fn();
    if (shouldOfferInstall({ standalone: isStandalone(), dismissedAt: read(DISMISSED_KEY), now: Date.now() })) show();
  });

  addEventListener('appinstalled', () => {
    deferred = null;
    hide();
    for (const fn of installedHandlers) fn();
  });

  return {
    onInstalled: (fn) => installedHandlers.push(fn),
    /** beforeinstallprompt를 받으면 부른다 */
    onOffered: (fn) => offeredHandlers.push(fn),
    get offered() {
      return offered;
    },
    /**
     * [비빔 앱 설치하기]: 받아 둔 설치 창이 있으면(Android·PC) 바로 띄우고, 없으면 설치 안내를 연다
     */
    install: () => {
      const e = deferred;
      if (!e) return openInstallGuide();
      deferred = null;
      hide();
      return e.prompt().then(() => e.userChoice).catch((err) => console.warn(err));
    },
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
    more: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 10.5l4 4 4-4'], // iOS 공유 시트의 더보기: 원 안의 아래 꺾쇠
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

/** 막는 화면 문구 (W-03). place: 설치한 웹앱을 여는 곳 */
const GATE = {
  ios: {
    lead: '애플 iOS 를 사용하고 있군요',
    title: '홈 화면에 추가해야 쓸 수 있어요',
    place: '홈 화면의 BeBeam',
    steps: () => [
      step('주소표시줄 옆 메뉴의 ', icon('share', '공유'), ' 공유 누르기'),
      step(icon('more', '더보기'), ' 더보기 메뉴 펼치기'),
      step(icon('add', '추가'), ' 홈 화면에 추가'),
    ],
    why: ['iOS는 저장소 관리가 까다로워서', '홈화면 저장소 하나로 비벼야 해요.'],
  },
  mac: {
    lead: '애플 MacOS의 Safari를 사용하고 있군요',
    title: 'Dock 에 추가해야 쓸 수 있어요',
    place: 'Dock의 BeBeam',
    steps: () => [
      step('Safari의 [파일] 메뉴를 펼치기'),
      step('“Dock에 추가...”를 실행하여 설치하기'),
    ],
    why: ['MacOS Safari는 저장소 관리가 까다로워서', 'Dock 저장소 하나로 비벼야 해요.'],
  },
};

/**
 * 설치 안내 (W-03, 막는 화면이 없는 브라우저). 브라우저의 설치 메뉴를 안내한다.
 */
export async function openInstallGuide() {
  await openDialog({
    title: '홈 화면에 추가하기',
    className: 'ios-guide',
    body: [
      h('ol', { class: 'ios-guide-steps' }, [
        step('주소표시줄 오른쪽의 설치 아이콘을 누르거나'),
        step('브라우저 메뉴(⋮)에서 [앱 설치] 또는 [홈 화면에 추가]'),
      ]),
      h('p', { class: 'dialog-message', text: '설치하면 오프라인에서도 바로 실행할 수 있어요.' }),
    ],
    buttons: [{ label: '확인', value: 'ok', kind: 'primary', autofocus: true }],
  });
}

/**
 * iOS·macOS Safari 브라우저 탭의 막는 화면 (W-03). 셸을 숨기고(시작도 하지 않는다) 설치 방법만 보인다. 닫을 수 없다.
 * @param {'ios' | 'mac'} kind installGate()의 결과
 */
export function showInstallGate(kind) {
  const g = GATE[kind];
  document.getElementById('shell').hidden = true;
  document.getElementById('notice').hidden = true;
  const gate = h('main', { class: 'ios-gate' }, [
    h('div', { class: 'ios-gate-card' }, [
      h('p', { class: 'brand' }, [h('img', { class: 'brand-icon', src: 'icons/icon-192.png', alt: '', width: '24', height: '24' }), ' BeBeam']),
      h('p', { class: 'ios-gate-lead', text: g.lead }),
      h('h1', { class: 'ios-gate-title', text: g.title }),
      h('ol', { class: 'ios-guide-steps' }, g.steps()),
      h('p', { class: 'ios-gate-note' }, [h('span', { class: 'ios-gate-em', text: `“${g.place}”` }), '을 눌러 실행하세요.']),
      h('div', { class: 'ios-gate-why' }, [
        lineIcon('circle-help'),
        h('div', {}, [...g.why, SITE_LABEL].map((text) => h('p', { text }))),
      ]),
    ]),
  ]);
  document.body.append(gate);
}

/**
 * 설치한 앱을 탭에서 열었을 때의 안내 (W-03). [앱으로 열기]는 OPEN_APP_URL로 앱 창을 연다(처음엔 브라우저가 묻는다).
 * [나중에]는 이번만 닫는다 (기억하지 않는다: 탭을 다시 열면 또 묻는다)
 */
export async function offerOpenApp() {
  const { value } = await openDialog({
    title: '설치한 BeBeam 앱이 있어요',
    className: 'open-app-dialog',
    body: [
      h('img', { class: 'open-app-icon', src: 'icons/icon-192.png', alt: '', width: '72', height: '72' }),
      h('p', { class: 'dialog-message', text: '앱으로 열면 별도 창에서 바로 실행돼요.' }),
    ],
    buttons: [
      { label: '나중에', value: 'later' },
      { label: '앱으로 열기', value: 'open', kind: 'primary', autofocus: true },
    ],
  });
  if (value === 'open') location.href = OPEN_APP_URL;
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
