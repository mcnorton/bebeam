// Service Worker 등록과 새 버전 감지 (SPEC F-01 5–6, ARCHITECTURE §7)
//   새 SW가 waiting이 되면 onWaiting을 부른다. 사용자가 승인하면 applyUpdate()로 skipWaiting하고,
//   제어권이 넘어오면 새로고침한다.
//   앱을 열 때와 화면으로 돌아올 때 서버의 version.js 번호를 읽어 더 높으면 곧바로 reg.update()한다.
//   브라우저가 sw.js를 다시 확인하는 때가 기기마다 달라 안내가 늦게 뜨는 것을 줄인다.
//   로컬 개발 서버(localhost)에서는 cache-first가 수정을 가리므로 ?sw=1일 때만 등록한다.

import { VERSION } from '../version.js';

const RETRY_MS = 20_000;
const RETRY_MAX = 3;

let waiting = null;
let reloading = false;
let checking = false;

/** version.js 원문에서 버전 문자열 (코드는 실행하지 않는다). 없으면 null */
export function readVersion(text) {
  return /export\s+const\s+VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/.exec(text)?.[1] ?? null;
}

/** remote가 local보다 높은 버전이면 true. CDN이 잠깐 옛 파일을 주어도 거꾸로 가지 않는다 */
export function isNewer(remote, local) {
  if (!remote || !local) return false;
  const a = remote.split('.').map(Number);
  const b = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** 서버의 버전 번호가 더 높으면 새 SW를 받는다. sw.js가 아직 옛것이면(CDN) 몇 번 더 확인한다 */
async function checkVersion(reg) {
  if (checking || reg.waiting) return;
  checking = true;
  try {
    let remote;
    try {
      // 검색어가 붙으면 셸 목록에 없어 sw.js가 가로채지 않고 네트워크로 간다
      const res = await fetch(`./version.js?check=${Date.now()}`, { cache: 'no-store' });
      remote = res.ok ? readVersion(await res.text()) : null;
    } catch {
      remote = null;
    }
    if (!remote) {
      // 확인하지 못했으면(오프라인 등) 브라우저에 맡긴다
      await reg.update().catch(() => {});
      return;
    }
    if (!isNewer(remote, VERSION)) return;
    for (let i = 0; i <= RETRY_MAX; i++) {
      if (i) await new Promise((r) => setTimeout(r, RETRY_MS));
      await reg.update().catch(() => {});
      if (reg.installing || reg.waiting) return;
    }
  } finally {
    checking = false;
  }
}

function isLocalDev() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).get('sw') !== '1';
}

/** @param {{onWaiting: () => void}} o */
export async function registerServiceWorker({ onWaiting }) {
  if (!('serviceWorker' in navigator) || isLocalDev()) return null;
  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('Service Worker를 등록하지 못했습니다', err);
    return null;
  }
  let hadController = !!navigator.serviceWorker.controller;
  const found = (worker) => {
    waiting = worker;
    onWaiting();
  };
  // 첫 설치(제어하는 SW가 없음)는 업데이트가 아니다
  if (reg.waiting && navigator.serviceWorker.controller) found(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) found(w);
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) {
      location.reload();
      return;
    }
    // 첫 설치의 clients.claim()이 아니라면 다른 탭이 새 버전을 활성화한 것이다.
    // 이 탭은 이전 코드로 새 캐시를 쓰게 되므로 새로고침을 권한다
    if (hadController) {
      waiting = null;
      onWaiting();
    }
    hadController = true;
  });
  checkVersion(reg);
  // 설치한 플레이어를 오래 켜 두는 경우: 화면으로 돌아올 때마다 새 버전을 확인한다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkVersion(reg);
  });
  return reg;
}

/** [새로고침]: 기다리는 새 버전을 활성화하고 새로고침한다 */
export function applyUpdate() {
  if (!waiting) return location.reload();
  reloading = true;
  waiting.postMessage({ type: 'skip-waiting' });
}
