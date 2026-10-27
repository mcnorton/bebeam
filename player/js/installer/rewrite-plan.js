// 참조 치환 계획 (ARCHITECTURE §4.3, DATABASE §2.5)
//   CSS: url(), @import 위치   JS: import 지정자, import.meta 위치   moduleOrder: 의존성 역순
// 위치는 blob.text()로 읽은 문자열의 UTF-16 인덱스다. 실행 시 bootstrap도 같은 방법으로 읽어야 한다.
// 치환 범위는 경로와 쿼리까지이며 #fragment는 남긴다 (blob URL은 쿼리를 해석하지 못한다).
// DOM 비의존 순수 모듈. HTML 인라인 모듈 스크립트는 호출자가 DOMParser로 뽑아 넘긴다.

import { init, parse } from '../../vendor/es-module-lexer/lexer.js';

export const PLAN_VERSION = 1;
export const VBASE = 'https://app.bebeam.invalid/';
const VORIGIN = new URL(VBASE).origin;

export const WARNINGS_MAX = 100;
const WARN_TEXT_MAX = 200;

/**
 * 참조 문자열 분류. 정규식이 아니라 브라우저와 같은 URL 파서의 해석을 기준으로 한다
 * (\\host, http:host, 탭이 섞인 스킴 등도 외부로 판정되도록).
 * @returns {'local' | 'external' | 'skip' | 'bare'}
 */
export function classifyRef(raw, { js = false, from = 'index.html' } = {}) {
  const s = String(raw ?? '').trim();
  if (!s || s.startsWith('#')) return 'skip';
  let absolute = true;
  try {
    new URL(s);
  } catch {
    absolute = false;
  }
  // JS 모듈 지정자는 ./ ../ / 로 시작하거나 절대 URL이어야 한다. 그 외는 bare specifier
  if (js && !absolute && !/^(\.{1,2}\/|\/)/.test(s)) return 'bare';
  let u;
  try {
    u = new URL(s, VBASE + from);
  } catch {
    return 'local'; // 해석할 수 없는 상대경로 → 이후 missing 경고
  }
  if (u.origin === VORIGIN) return 'local';
  return /^(https?|wss?|ftp):$/.test(u.protocol) ? 'external' : 'skip';
}

/** 외부 참조의 호스트 (C-6) */
export function externalHost(raw, from = 'index.html') {
  try {
    return new URL(String(raw).trim(), VBASE + from).host || null;
  } catch {
    return null;
  }
}

/** CSS 이스케이프 해제 (\68ttps → https). 분류용이며 치환 위치는 원문 기준이다 */
export function cssUnescape(s) {
  return s.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|(.))/gs, (_, hex, ch) => {
    if (ch !== undefined) return ch;
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
  });
}

/** 앱이 정한 문자열을 경고에 넣을 때는 길이를 자른다 */
function short(text) {
  return text.length > WARN_TEXT_MAX ? `${text.slice(0, WARN_TEXT_MAX)}…` : text;
}

/**
 * 앱 기준 경로로 해석한다. 앱 밖을 가리키면 null.
 * @returns {{path: string, keep: number} | null} keep: 치환하지 않고 남길 #fragment 길이
 */
export function resolveRef(raw, from) {
  let u;
  try {
    u = new URL(raw, VBASE + from);
  } catch {
    return null;
  }
  if (u.origin !== VORIGIN) return null;
  let path;
  try {
    path = decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
  const hash = raw.indexOf('#');
  return { path, keep: hash < 0 ? 0 : raw.length - hash };
}

/**
 * CSS 참조 토큰: url(...)과 @import "..."의 내용 위치 (따옴표·공백 제외)
 * @returns {{start: number, end: number}[]}
 */
export function cssRefs(text) {
  const out = [];
  const n = text.length;
  let i = 0;

  const skipWs = (j) => {
    while (j < n && /\s/.test(text[j])) j++;
    return j;
  };
  /** 따옴표 문자열 끝 다음 위치. 내용은 [j+1, end-1) */
  const stringEnd = (j) => {
    const q = text[j];
    let k = j + 1;
    while (k < n && text[k] !== q && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
    return Math.min(k + 1, n);
  };
  const isIdent = (c) => c !== undefined && /[\w-]/.test(c);

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      i = stringEnd(i);
    } else if ((c === 'u' || c === 'U') && text.slice(i, i + 4).toLowerCase() === 'url(' && !isIdent(text[i - 1])) {
      let j = skipWs(i + 4);
      if (text[j] === '"' || text[j] === "'") {
        const end = stringEnd(j);
        out.push({ start: j + 1, end: end - 1 });
        i = end;
      } else {
        const start = j;
        while (j < n && text[j] !== ')' && !/\s/.test(text[j])) j += text[j] === '\\' ? 2 : 1;
        if (j > start) out.push({ start, end: Math.min(j, n) });
        i = j;
      }
    } else if (c === '@' && text.slice(i + 1, i + 7).toLowerCase() === 'import' && !isIdent(text[i + 7])) {
      const j = skipWs(i + 7);
      if (text[j] === '"' || text[j] === "'") {
        const end = stringEnd(j);
        out.push({ start: j + 1, end: end - 1 });
        i = end;
      } else {
        i = j; // url(...) 형태는 다음 반복에서 처리
      }
    } else {
      i++;
    }
  }
  return out;
}

/** 경로 → 실제 파일 경로. 정확히 일치하지 않으면 대소문자 무시로 한 번 더 찾는다 (C-4) */
function makeLookup(paths) {
  const exact = new Set(paths);
  const lower = new Map();
  for (const p of paths) if (!lower.has(p.toLowerCase())) lower.set(p.toLowerCase(), p);
  return (path) => (exact.has(path) ? path : lower.get(path.toLowerCase()) ?? null);
}

/**
 * JS 소스의 import 치환 위치.
 * @returns {{imports: {start: number, end: number, ref: string}[], importMeta: {start: number, end: number}[], deps: string[], isModule: boolean}}
 */
function analyzeModule(src, from, ctx) {
  const [imports, exports] = parse(src, from);
  const out = { imports: [], importMeta: [], deps: [], isModule: exports.length > 0 || /\.mjs$/i.test(from) };
  for (const im of imports) {
    out.isModule ||= im.type === 'static' || im.type === 'import-meta';
    if (im.type === 'import-meta') {
      out.importMeta.push({ start: im.start, end: im.end });
      continue;
    }
    if (typeof im.specifier !== 'string') {
      ctx.warn(`dynamic-import:${from}`);
      continue;
    }
    let { start, end } = im;
    if (/^["'`]/.test(src[start])) {
      start++;
      end--;
    }
    const raw = src.slice(start, end);
    // 분류와 해석은 lexer가 디코드한 지정자로 (\u0068ttps 같은 이스케이프 우회 방지)
    const target = ctx.local(im.specifier, from, { js: true, raw });
    if (!target) continue;
    out.imports.push({ start, end: end - target.keep, ref: target.path });
    out.deps.push(target.path);
  }
  return out;
}

/** 의존성 역순 (leaf 먼저). 순환은 경고하고 그 간선을 무시한다 */
export function moduleOrder(graph, warn) {
  const order = [];
  const state = new Map(); // 1 = 방문 중, 2 = 완료
  const visit = (p, trail) => {
    if (state.get(p) === 2) return;
    if (state.get(p) === 1) {
      warn(`cyclic-import:${short([...trail.slice(trail.indexOf(p)), p].join('->'))}`);
      return;
    }
    state.set(p, 1);
    for (const d of graph.get(p) ?? []) if (graph.has(d)) visit(d, [...trail, p]);
    state.set(p, 2);
    order.push(p);
  };
  for (const p of [...graph.keys()].sort()) visit(p, []);
  return order;
}

/**
 * @param {{
 *   paths: string[],                       // 설치할 전체 파일 경로
 *   texts: Map<string, string>,            // CSS/JS 파일 내용 (blob.text())
 *   inlineModules?: Record<string, string[]>, // HTML 경로 → 인라인 <script type=module> 내용 (문서 순서)
 * }} input
 * @returns {Promise<{plan: object, externalHosts: string[]}>}
 */
export async function buildRewritePlan({ paths, texts, inlineModules = {} }) {
  await init();
  const lookup = makeLookup(paths);
  const warnings = new Set();
  const hosts = new Set();
  const ctx = {
    warn: (w) => {
      if (warnings.size < WARNINGS_MAX) warnings.add(w);
    },
    /**
     * 앱 안 파일로 해석되는 참조만 {path, keep}을 돌려준다.
     * value는 분류·해석에 쓰는 디코드된 값, raw는 원문(치환 범위와 #fragment 길이 계산용).
     */
    local(value, from, { js = false, raw = value } = {}) {
      const kind = classifyRef(value, { js, from });
      if (kind === 'external') {
        const h = externalHost(value, from);
        if (h) hosts.add(h);
        return null;
      }
      if (kind === 'bare') {
        ctx.warn(`bare-import:${from}:${short(value)}`);
        return null;
      }
      if (kind !== 'local') return null;
      const r = resolveRef(value, from);
      const path = r && lookup(r.path);
      if (!path) {
        ctx.warn(`missing:${from}->${short(value)}`);
        return null;
      }
      const hash = raw.indexOf('#');
      return { path, keep: hash < 0 ? 0 : raw.length - hash };
    },
  };

  const css = {};
  const modules = {};
  const graph = new Map();
  for (const path of [...texts.keys()].sort()) {
    const text = texts.get(path);
    if (/\.css$/i.test(path)) {
      const edits = [];
      for (const { start, end } of cssRefs(text)) {
        const raw = text.slice(start, end);
        const t = ctx.local(cssUnescape(raw), path, { raw });
        if (t) edits.push({ start, end: end - t.keep, ref: t.path });
      }
      if (edits.length) css[path] = edits;
    } else if (/\.m?js$/i.test(path)) {
      let m;
      try {
        m = analyzeModule(text, path, ctx);
      } catch {
        ctx.warn(`parse-error:${path}`);
        continue;
      }
      if (!m.isModule && !m.imports.length) continue;
      modules[path] = { imports: m.imports, importMeta: m.importMeta };
      graph.set(path, m.deps);
    }
  }

  const inline = {};
  for (const [html, scripts] of Object.entries(inlineModules)) {
    inline[html] = scripts.map((src, i) => {
      try {
        const { imports, importMeta } = analyzeModule(src, html, ctx);
        return { imports, importMeta };
      } catch {
        ctx.warn(`parse-error:${html}#${i}`);
        return { imports: [], importMeta: [] };
      }
    });
  }

  const order = moduleOrder(graph, ctx.warn);
  return {
    plan: { version: PLAN_VERSION, css, modules, inline, moduleOrder: order, warnings: [...warnings] },
    externalHosts: [...hosts],
  };
}
