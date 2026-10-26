// 앱 iframe 내부 코드 (ARCHITECTURE §4.2, §4.5)
//   host가 bootstrapMain의 소스를 srcdoc 스크립트로 인라인한다. 함께 인라인되는 전역:
//   VBASE, cssRefs, resolveVirtual, applyEdits, rewriteCssText, rewriteSrcset, createStorageBatcher
//   이 함수는 자기 완결적이어야 하며(모듈 스코프 참조 금지), 닫는 script 태그 문자열을 넣지 않는다.
//
// 메시지 (모두 type 접두어 'toybox:')
//   iframe → host: ready, rendering{page}, started{page}, pong{challenge}, storage{batch}, flushed, navigating, log{level, message}, error{message}
//   host → iframe: boot{files, plan, entry, storage, parentOrigin, nonce}, ping{challenge}, flush
//   rendering·started·pong·error에는 boot에서 받은 nonce를 담는다. 앱 코드는 이 클로저에 닿지 못하므로 위조할 수 없다.
//   host는 iframe load마다 ping을 보내고, nonce가 담긴 pong이 오지 않으면 앱이 다른 문서로 이동한 것으로 본다 (§4.6)

/* global VBASE, resolveVirtual, applyEdits, rewriteCssText, rewriteSrcset, createStorageBatcher */

export function bootstrapMain() {
  'use strict';

  const STORAGE_QUOTA = 5 * 1024 * 1024; // bytes, (key + value) × 2
  const FLUSH_DELAY = 100;
  const URL_ATTRS = [
    ['script', 'src'], ['link', 'href'], ['img', 'src'], ['source', 'src'], ['audio', 'src'],
    ['video', 'src'], ['video', 'poster'], ['track', 'src'], ['input', 'src'], ['image', 'href'], ['use', 'href'],
  ];

  const parentWin = window.parent;
  let parentOrigin = '*';
  let nonce = '';
  const post = (msg) => parentWin.postMessage(msg, parentOrigin);

  // 앱 코드보다 먼저 잡아 둔 내장 함수. 앱이 나중에 원본을 바꿔도 bootstrap의 렌더링·신호·타이머는
  // 이것을 쓴다 (앱이 Document.prototype.open이나 clearTimeout을 덮어써 감지를 방해하지 못하게)
  const apply = Reflect.apply;
  const docOpen = Document.prototype.open;
  const docWrite = Document.prototype.write;
  const docClose = Document.prototype.close;
  const addListener = EventTarget.prototype.addEventListener;
  const setTimer = window.setTimeout;
  const clearTimer = window.clearTimeout;
  const listen = (target, type, fn, capture = false) => apply(addListener, target, [type, fn, capture]);
  const later = (fn, ms) => apply(setTimer, window, [fn, ms]);
  const cancelLater = (id) => apply(clearTimer, window, [id]);

  /** @type {Record<string, Blob>} */
  let files = {};
  let lowerIndex = new Map();
  const urls = new Map(); // 실제 path → blob URL
  let plan = { css: {}, modules: {}, inline: {}, moduleOrder: [] };
  let pagePath = 'index.html';
  let flushStorage = () => {};

  // ───────── 부팅 ─────────
  let booted = false;
  window.addEventListener('message', function onBoot(e) {
    if (e.source !== parentWin || booted) return;
    const m = e.data;
    if (!m || m.type !== 'toybox:boot') return;
    booted = true;
    window.removeEventListener('message', onBoot);
    if (typeof m.parentOrigin === 'string') parentOrigin = m.parentOrigin;
    if (typeof m.nonce === 'string') nonce = m.nonce;
    boot(m).catch((err) => post({ type: 'toybox:error', message: String((err && err.message) || err).slice(0, 500), nonce }));
  });
  parentWin.postMessage({ type: 'toybox:ready' }, '*');

  async function boot(m) {
    files = m.files || {};
    plan = { css: {}, modules: {}, inline: {}, moduleOrder: [], ...(m.plan || {}) };
    lowerIndex = new Map(Object.keys(files).map((p) => [p.toLowerCase(), p]));
    const entry = lookup(m.entry || 'index.html');
    if (!entry) throw new Error('진입 파일을 찾을 수 없습니다');

    removeDangerousApis();
    installStorage(m.storage || {});

    // 1) 텍스트가 아닌 에셋과 치환할 것이 없는 파일: 그대로
    for (const [path, blob] of Object.entries(files)) {
      if (!/\.(css|m?js|html?)$/i.test(path)) urls.set(path, URL.createObjectURL(blob));
    }
    // 2) CSS: @import 대상을 먼저 만든다 (순환은 원문 유지)
    for (const path of Object.keys(files)) if (/\.css$/i.test(path)) await cssUrl(path, []);
    // 3) JS 모듈: 의존성 역순 (leaf 먼저)
    for (const path of plan.moduleOrder) {
      if (!files[path] || !plan.modules[path]) continue;
      const src = await files[path].text();
      const out = rewriteModule(src, plan.modules[path], path);
      urls.set(path, URL.createObjectURL(new Blob([out], { type: 'text/javascript' })));
    }
    // 4) 나머지 JS(클래식 스크립트, 워커)
    for (const [path, blob] of Object.entries(files)) {
      if (/\.m?js$/i.test(path) && !urls.has(path)) urls.set(path, URL.createObjectURL(blob));
    }

    installNetworkShims();
    await render(entry);
  }

  // ───────── 경로 ─────────
  function lookup(path) {
    if (path == null) return null;
    if (Object.prototype.hasOwnProperty.call(files, path)) return path;
    return lowerIndex.get(String(path).toLowerCase()) || null;
  }
  function urlFor(ref, from) {
    const real = lookup(resolveVirtual(ref, from, VBASE));
    return real ? urls.get(real) || null : null;
  }
  const mapUrl = (v) => {
    if (v == null) return v;
    const s = v instanceof URL ? v.href : String(v);
    return urlFor(s, pagePath) || v;
  };

  function rewriteModule(src, m, from) {
    const edits = [
      ...(m.imports || []).map((e) => ({ ...e, kind: 'import' })),
      ...(m.importMeta || []).map((e) => ({ ...e, kind: 'meta' })),
    ];
    return applyEdits(src, edits, (ed) => {
      if (ed.kind === 'meta') return `({url:${JSON.stringify(VBASE + from)}})`;
      return urls.get(ed.ref) || null;
    });
  }

  async function cssUrl(path, stack) {
    if (urls.has(path)) return urls.get(path);
    const text = await files[path].text();
    const edits = (plan.css && plan.css[path]) || [];
    for (const ed of edits) {
      if (/\.css$/i.test(ed.ref) && files[ed.ref] && !stack.includes(ed.ref) && ed.ref !== path) {
        await cssUrl(ed.ref, [...stack, path]);
      }
    }
    const out = applyEdits(text, edits, (ed) => urls.get(ed.ref) || null);
    const u = URL.createObjectURL(new Blob([out], { type: 'text/css' }));
    urls.set(path, u);
    return u;
  }

  // ───────── 위험 API 제거 (§4.5) ─────────
  function removeDangerousApis() {
    const block = (obj, key, message) => {
      try {
        Object.defineProperty(obj, key, {
          get() { throw new DOMException(message, 'SecurityError'); },
          configurable: false,
        });
      } catch {
        // 이미 설정 불가한 속성
      }
    };
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
      try {
        Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false });
      } catch {}
    }
    block(window, 'indexedDB', 'Toybox 앱에서는 indexedDB를 쓸 수 없습니다 (localStorage를 쓰세요)');
    block(window, 'caches', 'Toybox 앱에서는 Cache Storage를 쓸 수 없습니다');
    try {
      Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined, configurable: false });
    } catch {}
  }

  // ───────── localStorage / sessionStorage shim ─────────
  function makeStorage(initial, sink) {
    const map = new Map();
    let used = 0;
    for (const [k, v] of Object.entries(initial)) {
      if (typeof v !== 'string') continue;
      map.set(k, v);
      used += (k.length + v.length) * 2;
    }
    const api = {
      get length() { return map.size; },
      key(i) { return [...map.keys()][i] ?? null; },
      getItem(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem(k, v) {
        k = String(k);
        v = String(v);
        const prev = map.has(k) ? (k.length + map.get(k).length) * 2 : 0;
        const next = used - prev + (k.length + v.length) * 2;
        if (next > STORAGE_QUOTA) throw new DOMException('저장 공간(5MB)을 초과했습니다', 'QuotaExceededError');
        used = next;
        map.set(k, v);
        sink && sink.set(k, v);
      },
      removeItem(k) {
        k = String(k);
        if (!map.has(k)) return;
        used -= (k.length + map.get(k).length) * 2;
        map.delete(k);
        sink && sink.remove(k);
      },
      clear() {
        map.clear();
        used = 0;
        sink && sink.clear();
      },
    };
    return new Proxy(api, {
      get(t, p) { return typeof p === 'symbol' || p in t ? Reflect.get(t, p) : t.getItem(p) ?? undefined; },
      set(t, p, v) { if (typeof p === 'symbol' || p in t) return false; t.setItem(p, v); return true; },
      deleteProperty(t, p) { t.removeItem(p); return true; },
      has(t, p) { return p in t || map.has(String(p)); },
      ownKeys() { return [...map.keys()]; },
      getOwnPropertyDescriptor(t, p) {
        return map.has(String(p)) ? { value: map.get(String(p)), enumerable: true, configurable: true, writable: true } : undefined;
      },
      defineProperty(t, p, desc) {
        if (typeof p === 'symbol' || p in t || !('value' in desc)) return false;
        t.setItem(p, desc.value);
        return true;
      },
    });
  }

  function installStorage(snapshot) {
    const batcher = createStorageBatcher();
    let timer = 0;
    flushStorage = () => {
      cancelLater(timer);
      timer = 0;
      const batch = batcher.take();
      if (batch) post({ type: 'toybox:storage', batch });
    };
    const schedule = () => {
      if (!timer) timer = later(flushStorage, FLUSH_DELAY);
    };
    const sink = {
      set(k, v) { batcher.set(k, v); schedule(); },
      remove(k) { batcher.remove(k); schedule(); },
      clear() { batcher.clear(); schedule(); },
    };
    const local = makeStorage(snapshot, sink);
    const session = makeStorage({}, null);
    Object.defineProperty(window, 'localStorage', { get: () => local, configurable: false });
    Object.defineProperty(window, 'sessionStorage', { get: () => session, configurable: false });
  }

  // ───────── fetch / XHR / src setter / Worker / Audio (§4.5) ─────────
  function installNetworkShims() {
    const realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      const u = urlFor(raw, pagePath);
      if (u) return realFetch(u, init);
      // 앱 안을 가리키지만 없는 파일은 404 (외부 URL은 그대로 보내 CSP가 막게 한다)
      if (resolveVirtual(raw, pagePath, VBASE) != null) return Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' }));
      return realFetch(input, init);
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      return xhrOpen.call(this, method, mapUrl(url), ...rest);
    };

    for (const [ctor, prop] of [
      [HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLTrackElement, 'src'],
      [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLVideoElement, 'poster'], [HTMLInputElement, 'src'],
    ]) {
      const d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(ctor.prototype, prop, { ...d, set(v) { d.set.call(this, mapUrl(v)); } });
    }
    for (const ctor of [HTMLImageElement, HTMLSourceElement]) {
      const d = Object.getOwnPropertyDescriptor(ctor.prototype, 'srcset');
      if (d && d.set) {
        Object.defineProperty(ctor.prototype, 'srcset', { ...d, set(v) { d.set.call(this, rewriteSrcset(v, (r) => urlFor(r, pagePath))); } });
      }
    }

    const setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const n = String(name).toLowerCase();
      if ((n === 'src' || n === 'href' || n === 'poster' || n === 'xlink:href') && !(this instanceof HTMLAnchorElement)) value = mapUrl(value);
      else if (n === 'srcset') value = rewriteSrcset(value, (r) => urlFor(r, pagePath));
      return setAttr.call(this, name, value);
    };

    const RealWorker = window.Worker;
    if (RealWorker) {
      const ShimWorker = function Worker(url, opts) { return new RealWorker(mapUrl(url), opts); };
      ShimWorker.prototype = RealWorker.prototype;
      window.Worker = ShimWorker;
    }
    const RealAudio = window.Audio;
    const ShimAudio = function Audio(src) {
      const a = new RealAudio();
      if (src !== undefined) a.src = src;
      return a;
    };
    ShimAudio.prototype = RealAudio.prototype;
    window.Audio = ShimAudio;
  }

  // innerHTML 등으로 나중에 들어온 요소의 상대경로 속성 보정
  function observeMutations() {
    const fix = (el) => {
      if (!(el instanceof Element) || el instanceof HTMLAnchorElement) return;
      for (const a of ['src', 'href', 'poster']) {
        const v = el.getAttribute(a);
        if (v != null) {
          const u = urlFor(v, pagePath);
          if (u) el.setAttribute(a, u);
        }
      }
    };
    new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          fix(n);
          if (n.querySelectorAll) n.querySelectorAll('[src],[href],[poster]').forEach(fix);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  }

  // ───────── HTML 렌더링 ─────────
  async function render(path) {
    pagePath = path;
    const html = await files[path].text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ref = (r) => urlFor(r, path);

    for (const [tag, attr] of URL_ATTRS) {
      for (const el of doc.querySelectorAll(`${tag}[${attr}]`)) {
        const u = ref(el.getAttribute(attr));
        if (u) el.setAttribute(attr, u);
      }
    }
    for (const el of doc.querySelectorAll('image, use')) {
      const v = el.getAttribute('xlink:href');
      const u = v != null && ref(v);
      if (u) el.setAttribute('xlink:href', u);
    }
    for (const el of doc.querySelectorAll('img[srcset], source[srcset]')) el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'), ref));
    for (const el of doc.querySelectorAll('style')) el.textContent = rewriteCssText(el.textContent, ref);
    for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style', rewriteCssText(el.getAttribute('style'), ref));
    // 이동·외부 문서 로드를 일으키는 요소는 제거한다
    for (const el of doc.querySelectorAll('base, object, embed, meta[http-equiv="refresh" i]')) el.remove();

    const inline = (plan.inline && plan.inline[path]) || [];
    [...doc.querySelectorAll('script[type="module" i]:not([src])')].forEach((el, i) => {
      if (inline[i]) el.textContent = rewriteModule(el.textContent, inline[i], path);
    });

    const out = '<!doctype html>\n' + doc.documentElement.outerHTML;

    // document.open/write는 iframe load를 다시 일으키므로 host에 미리 알린다 (§4.6)
    post({ type: 'toybox:rendering', page: path, nonce });
    apply(docOpen, document, []);
    // document.open()은 window의 이벤트 리스너를 모두 지운다 → write 전에 다시 등록한다
    installRuntimeListeners();
    apply(docWrite, document, [out]);
    apply(docClose, document, []);
    observeMutations();
    post({ type: 'toybox:started', page: path, nonce });
  }

  function installRuntimeListeners() {
    // opaque iframe의 오류는 부모 콘솔에 보이지 않으므로 host에 보고한다 (capture: 리소스 실패 포함)
    window.addEventListener('error', (e) => {
      const t = e.target;
      const res = t && t !== window && (t.currentSrc || t.src || t.href);
      const message = res ? `리소스 로드 실패: ${t.tagName} ${String(res).slice(0, 80)}` : `${e.message} (${e.lineno}:${e.colno})`;
      post({ type: 'toybox:log', level: 'error', message: message.slice(0, 500) });
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      post({ type: 'toybox:log', level: 'error', message: `처리되지 않은 Promise 거부: ${String((r && r.message) || r).slice(0, 400)}` });
    });
    // capture로, 앱 코드보다 먼저 등록한다 (앱이 나중에 단 리스너로 가로채지 못하게)
    listen(window, 'message', (e) => {
      if (e.source !== parentWin) return;
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'toybox:ping' && typeof m.challenge === 'string') {
        post({ type: 'toybox:pong', challenge: m.challenge, nonce });
      } else if (m.type === 'toybox:flush') {
        try {
          flushStorage();
        } finally {
          post({ type: 'toybox:flushed' });
        }
      }
    }, true);
    listen(window, 'pagehide', () => {
      // 이동 신호를 먼저 보낸다 (flush가 실패해도 신호는 나가도록)
      post({ type: 'toybox:navigating' });
      try {
        flushStorage();
      } catch {}
    }, true);
    // 내부 HTML 링크: 같은 iframe에서 그 페이지를 다시 렌더링한다 (T2.3). 저장소는 유지된다
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href[0] === '#') return;
      const real = lookup(resolveVirtual(href, pagePath, VBASE));
      e.preventDefault(); // 앱 밖으로의 이동은 막는다 (sandbox가 top 이동도 막지만 iframe 자체 이동 방지)
      if (real && /\.html?$/i.test(real)) render(real);
    }, true);
  }
}
