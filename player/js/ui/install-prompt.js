// 플레이어 설치 강제와 저장소 유지 요청 (SPEC F-01 3–4, W-03)
//   브라우저마다 저장소가 따로라서 앱이 여기저기 흩어지지 않게, 설치한 앱 창(standalone)이 아니면 셸 대신 막는 화면만 보인다 (2026-11-12).
//   iOS 홈 화면 · macOS Safari Dock · Chrome·Edge·Android [설치](beforeinstallprompt) · 그 밖의 Android 브라우저 메뉴 · 그 밖의 컴퓨터 브라우저는 Chrome·Edge 안내.
//   navigator.storage.persist()는 처음 한 번 요청하고 결과를 meta.settings.persisted에 기록한다.

import { getMeta, setMeta } from '../db.js';
import { h } from './dialogs.js';
import { icon as lineIcon } from './icons.js';
import { renderQR } from '../transfer/qr.js';
import { isAppRunning } from '../presence.js';

/** 설치한 앱 창을 여는 주소. manifest protocol_handlers로 설치한 앱에 등록된다 (컴퓨터 Chrome·Edge) */
export const OPEN_APP_URL = 'web+bebeam://open';
/** 설치 이벤트(beforeinstallprompt)를 기다리는 시간. 이 안에 오지 않으면 이미 설치한 것으로 본다 (Chromium은 설치한 앱이면 보내지 않는다) */
export const OFFER_WAIT_MS = 2000;
/** [앱으로 열기] 뒤 앱 창이 뜨기를 기다리는 시간 (브라우저 확인 창을 누르는 시간 포함), 묻는 간격 */
const APP_WAIT_MS = 8000;
const APP_POLL_MS = 500;

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

/**
 * macOS의 Safari (Dock에 추가로 웹앱을 만든다). Safari를 흉내 내는 Chrome·Edge·Firefox·Opera는 뺀다.
 * assets/landing.js에 같은 규칙이 있다
 */
export function isMacSafari({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (isIos({ userAgent, platform, maxTouchPoints })) return false;
  return /Macintosh/.test(userAgent) && /Version\/[\d.]+.* Safari\//.test(userAgent) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(userAgent);
}

/**
 * 설치한 앱 창이 아니면 막는 화면의 종류: 'ios'(홈 화면) | 'mac'(Dock) | 'install'([설치] 버튼) | 'android'(브라우저 메뉴) | 'browser'(Chrome·Edge 안내) | null.
 * promptSupported: beforeinstallprompt를 지원하는 브라우저 (Chrome·Edge·Android Chrome 등)
 */
export function installGate({ ios, macSafari, standalone, promptSupported = false, android = false }) {
  if (standalone) return null;
  if (ios) return 'ios';
  if (macSafari) return 'mac';
  if (promptSupported) return 'install';
  return android ? 'android' : 'browser';
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

/** 창 모드가 바뀌면(전체 화면 들어가기·나오기 등) 부른다 */
export function onDisplayModeChange(fn) {
  matchMedia(INSTALLED_DISPLAY_QUERY).addEventListener('change', fn);
}

/**
 * beforeinstallprompt를 받아 둔다. 일찍 올 수 있으므로 DB를 열기 전에 부른다. 막는 화면의 [설치]가 쓴다
 */
export function setupInstallPrompt() {
  let deferred = null;
  const installedHandlers = [];
  const offeredHandlers = [];

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 브라우저 기본 미니 인포바 대신 막는 화면의 [설치]
    deferred = e;
    for (const fn of offeredHandlers) fn();
  });

  addEventListener('appinstalled', () => {
    deferred = null;
    for (const fn of installedHandlers) fn();
  });

  return {
    onInstalled: (fn) => installedHandlers.push(fn),
    /** beforeinstallprompt를 받으면 부른다 */
    onOffered: (fn) => offeredHandlers.push(fn),
    get offered() {
      return deferred !== null;
    },
    /** 받아 둔 설치 창을 띄운다 */
    install: () => {
      const e = deferred;
      if (!e) return Promise.resolve();
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

/** 막는 화면 문구 (W-03). place: 설치한 웹앱을 여는 곳 (없으면 안내 줄을 뺀다) */
const DESKTOP_PLACE = '바탕화면(홈 화면)의 BeBeam';
const WHY = ['브라우저마다 저장소가 따로라서', '설치한 앱 하나로 비벼야 앱이 흩어지지 않아요.'];
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
  install: {
    lead: '비빔은 설치해서 쓰는 앱이에요',
    title: '설치해야 쓸 수 있어요',
    place: DESKTOP_PLACE,
    steps: () => [
      step('아래 [설치] 누르기'),
      step('설치 창에서 한 번 더 [설치] 누르기'),
    ],
    why: WHY,
  },
  android: {
    lead: '비빔은 설치해서 쓰는 앱이에요',
    title: '홈 화면에 추가해야 쓸 수 있어요',
    place: '홈 화면의 BeBeam',
    steps: () => [
      step('브라우저 메뉴(⋮ 또는 ≡) 펼치기'),
      step('[앱 설치] 또는 [홈 화면에 추가] 누르기'),
    ],
    why: WHY,
  },
  browser: {
    lead: '이 브라우저에서는 비빔을 설치할 수 없어요',
    title: 'Chrome이나 Edge에서 열어 주세요',
    place: '',
    steps: () => [
      step('Chrome이나 Edge 열기'),
      step(`주소창에 ${SITE_LABEL}/player/ 입력하기`),
      step('[설치] 누르기'),
    ],
    why: WHY,
  },
};

/**
 * 설치한 앱 창이 아닐 때의 막는 화면 (W-03). 셸을 숨기고 설치 방법만 보인다. 닫을 수 없다.
 * 'install'은 [설치] 버튼을 둔다. 설치 이벤트가 오지 않으면 이미 설치한 것이므로 아이콘으로 열라고 하고, 컴퓨터면 [앱으로 열기]를 둔다.
 * @param {'ios' | 'mac' | 'install' | 'android' | 'browser'} kind installGate()의 결과
 * @param {ReturnType<typeof setupInstallPrompt>} [prompt] 'install'에서 쓴다
 */
export function showInstallGate(kind, prompt) {
  const g = GATE[kind];
  document.getElementById('shell').hidden = true;
  document.getElementById('notice').hidden = true;
  const actions = h('div', { class: 'ios-gate-actions' });
  const gate = h('main', { class: 'ios-gate' }, [
    h('div', { class: 'ios-gate-card' }, [
      h('p', { class: 'brand' }, [h('img', { class: 'brand-icon', src: 'icons/icon-192.png', alt: '', width: '24', height: '24' }), ' BeBeam']),
      h('p', { class: 'ios-gate-lead', text: g.lead }),
      h('h1', { class: 'ios-gate-title', text: g.title }),
      h('ol', { class: 'ios-guide-steps' }, g.steps()),
      kind === 'install' ? actions : '',
      g.place ? h('p', { class: 'ios-gate-note' }, ['설치한 뒤에는 ', h('span', { class: 'ios-gate-em', text: `“${g.place}”` }), ' 아이콘으로 여세요.']) : '',
      h('div', { class: 'ios-gate-why' }, [
        lineIcon('circle-help'),
        h('div', {}, [...g.why, SITE_LABEL].map((text) => h('p', { text }))),
      ]),
    ]),
  ]);
  document.body.append(gate);
  if (kind !== 'install' || !prompt) return;

  const install = h('button', { type: 'button', class: 'btn btn-primary ios-gate-install', text: '설치', disabled: !prompt.offered });
  install.addEventListener('click', () => prompt.install());
  actions.append(install);
  prompt.onOffered(() => { install.disabled = false; });
  const installed = (text) => {
    const children = [h('p', { class: 'ios-gate-done', text })];
    // 컴퓨터 Chrome·Edge는 protocol_handlers로 설치한 앱 창을 열 수 있다 (Android는 없다)
    if (!/Android/.test(navigator.userAgent)) {
      const open = h('button', { type: 'button', class: 'btn btn-primary ios-gate-install' }, [h('img', { class: 'open-app-mark', src: 'icons/icon-192.png', alt: '', width: '20', height: '20' }), ' 앱으로 열기']);
      open.addEventListener('click', () => openInstalledApp());
      children.push(open);
    }
    actions.replaceChildren(...children);
  };
  prompt.onInstalled(() => installed('설치했어요! 이제 비빔 아이콘으로 열어요.'));
  setTimeout(() => {
    if (!prompt.offered) installed('이미 설치했네요. 비빔 아이콘으로 열어요.');
  }, OFFER_WAIT_MS);
}

/**
 * 설치한 앱 창을 연다. 이 탭은 앱 창이 뜨면 닫아 보고(스크립트로 연 탭만 닫힌다), 닫히지 않으면 막는 모달을 둔다.
 * @param {{onRefresh?: () => Promise<void>}} o 앱이 실행 중일 때 [새로고침]이 부른다 (목록 다시 읽기)
 */
export function openInstalledApp({ onRefresh } = {}) {
  location.href = OPEN_APP_URL;
  showAppWait(onRefresh);
  closeWhenAppOpens();
}

async function closeWhenAppOpens() {
  for (let waited = 0; waited < APP_WAIT_MS; waited += APP_POLL_MS) {
    if (await isAppRunning(APP_POLL_MS)) {
      window.close();
      return;
    }
  }
}

/** 앱으로 비비는 동안 이 탭을 막는다. Esc·배경으로 닫히지 않고 [새로고침]으로만 판단한다 */
function showAppWait(onRefresh) {
  if (document.querySelector('.open-app-wait')) return;
  const shell = document.getElementById('shell');
  const status = h('p', { class: 'open-app-wait-status', 'aria-live': 'polite' });
  const refresh = h('button', { type: 'button', class: 'btn btn-primary open-app-refresh' }, ['새로고침', lineIcon('refresh-cw')]);
  const layer = h('div', { class: 'open-app-wait', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'open-app-wait-title' }, [
    h('div', { class: 'open-app-wait-card' }, [
      h('img', { class: 'open-app-icon', src: 'icons/icon-192.png', alt: '', width: '72', height: '72' }),
      h('p', { id: 'open-app-wait-title', class: 'open-app-wait-title', text: '설치된 앱으로 비비는 중입니다.' }),
      refresh,
      status,
    ]),
  ]);
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    status.textContent = '';
    if (await isAppRunning()) {
      await onRefresh?.();
      status.textContent = '앱이 아직 열려 있어요. 목록을 새로 읽었어요.';
    } else {
      layer.remove();
      shell.inert = false;
    }
    refresh.disabled = false;
  });
  shell.inert = true;
  document.body.append(layer);
  refresh.focus();
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
