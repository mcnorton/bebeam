// Service Worker: 셸 precache, cache-first, 이전 캐시 정리 (ARCHITECTURE §7, SPEC F-01)
//   SHELL에 있는 URL만 처리한다. 그 밖의 요청(앱 iframe 등)은 건드리지 않고 네트워크로 보낸다.
//   새 버전은 waiting으로 두고, 화면이 사용자 승인 뒤 'skip-waiting' 메시지를 보낸다.

// @stamp-begin (scripts/sw-stamp.mjs가 쓴다. 직접 고치지 않는다)
const VERSION = '8a41de35371c';
const SHELL = [
  './',
  'css/player.css',
  'icons/app-192.png',
  'icons/app-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.ico',
  'icons/icon-192.png',
  'index.html',
  'js/db.js',
  'js/ids.js',
  'js/installer/duplicates.js',
  'js/installer/install.js',
  'js/installer/meta.js',
  'js/installer/rewrite-plan.js',
  'js/installer/source.js',
  'js/installer/validate.js',
  'js/main.js',
  'js/names.js',
  'js/runtime/bootstrap.js',
  'js/runtime/host.js',
  'js/runtime/rewrite.js',
  'js/settings.js',
  'js/store.js',
  'js/theme-init.js',
  'js/transfer/base45.js',
  'js/transfer/beam.js',
  'js/transfer/broadcast.js',
  'js/transfer/crc32.js',
  'js/transfer/decoder.worker.js',
  'js/transfer/fountain.js',
  'js/transfer/link.js',
  'js/transfer/pipeline.js',
  'js/transfer/qr.js',
  'js/transfer/rtc-link.js',
  'js/transfer/sdp.js',
  'js/ui/add-sheet.js',
  'js/ui/dialogs.js',
  'js/ui/icons.js',
  'js/ui/install-prompt.js',
  'js/ui/list.js',
  'js/ui/menu.js',
  'js/ui/settings.js',
  'js/ui/theme.js',
  'js/ui/transfer-view.js',
  'js/ui/viewer.js',
  'js/update.js',
  'manifest.webmanifest',
  'vendor/es-module-lexer/lexer.js',
  'vendor/fflate/fflate.js',
  'vendor/neodgm-pro/NeoDunggeunmoPro-Regular.woff2',
  'vendor/qrcode-generator/qrcode.mjs',
  'vendor/zxing-wasm/es/reader/index.js',
  'vendor/zxing-wasm/es/share.js',
  'vendor/zxing-wasm/reader/zxing_reader.wasm',
  'version.js',
];
// @stamp-end

const PREFIX = 'bebeam-shell-v';
const CACHE = PREFIX + VERSION;
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).href));

self.addEventListener('install', (event) => {
  // cache: 'reload' — HTTP 캐시에 남은 이전 파일을 precache하지 않도록
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.hash = '';
  // 플레이어 페이지 이동은 검색어(?…)가 붙어도 셸로 연다
  if (req.mode === 'navigate') url.search = '';
  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith((async () => {
    const hit = await caches.match(url.href, { cacheName: CACHE });
    if (hit) return hit;
    // 캐시가 비워졌으면(저장소 정리 등) 네트워크에서 받아 다시 채운다
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(url.href, copy)));
    }
    return res;
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});
