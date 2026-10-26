// Service Worker 등록과 새 버전 감지 (SPEC F-01 5–6, ARCHITECTURE §7)
//   새 SW가 waiting이 되면 onWaiting을 부른다. 사용자가 승인하면 applyUpdate()로 skipWaiting하고,
//   제어권이 넘어오면 새로고침한다.
//   로컬 개발 서버(localhost)에서는 cache-first가 수정을 가리므로 ?sw=1일 때만 등록한다.

let waiting = null;
let reloading = false;

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
  // 설치한 플레이어를 오래 켜 두는 경우: 화면으로 돌아올 때마다 새 버전을 확인한다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
  return reg;
}

/** [새로고침]: 기다리는 새 버전을 활성화하고 새로고침한다 */
export function applyUpdate() {
  if (!waiting) return location.reload();
  reloading = true;
  waiting.postMessage({ type: 'skip-waiting' });
}
