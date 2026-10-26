// 메타데이터 추출과 외부 리소스 감지 (SPEC C-5, C-6)
//   readHtml: DOMParser로 index.html을 읽는다 (브라우저 전용, 문서를 플레이어 DOM에 넣지 않는다)
//   deriveMeta, externalHostsOf: 순수 함수 (Node 테스트)

import { classifyRef, cssRefs, cssUnescape, externalHost, resolveRef } from './rewrite-plan.js';
import { mimeOf } from './validate.js';

export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 200;
export const EXTERNAL_MAX = 10;
export const DEFAULT_NAME = '이름 없는 앱';
const ICON_FALLBACKS = ['favicon.ico', 'favicon.png', 'favicon.svg', 'icon.png'];

// 양방향 제어(이름 위장)와 폭 없는 문자(보이지 않는 이름)
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** 보이지 않는 문자를 지우고, 공백을 하나로 줄이고, 코드 포인트 기준으로 자른다 */
export function clean(text, max) {
  const s = String(text ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : s;
}

/** 리소스를 가리키는 HTML 속성 (C-6) */
const REF_ATTRS = [
  ['script[src]', 'src'],
  ['link[href]', 'href'],
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['audio[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['track[src]', 'src'],
  ['iframe[src]', 'src'],
  ['embed[src]', 'src'],
  ['object[data]', 'data'],
];

/** srcset 값에서 URL만 뽑는다 */
export function srcsetUrls(value) {
  return String(value)
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * @param {string} text index.html 내용
 * @param {typeof DOMParser} [Parser]
 * @returns {{title: string, description: string, iconHrefs: string[], refs: string[], inlineModules: string[]}}
 */
export function readHtml(text, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(text, 'text/html');
  const content = (sel) => doc.querySelector(sel)?.getAttribute('content') ?? '';

  const iconHrefs = [];
  for (const rel of ['icon', 'apple-touch-icon']) {
    for (const link of doc.querySelectorAll('link[rel][href]')) {
      const rels = link.getAttribute('rel').toLowerCase().split(/\s+/);
      if (rels.includes(rel)) iconHrefs.push(link.getAttribute('href'));
    }
  }

  const refs = [];
  for (const [sel, attr] of REF_ATTRS) {
    for (const el of doc.querySelectorAll(sel)) refs.push(el.getAttribute(attr));
  }
  for (const el of doc.querySelectorAll('img[srcset], source[srcset]')) refs.push(...srcsetUrls(el.getAttribute('srcset')));
  // 인라인 SVG의 href (ARCHITECTURE §4.3)
  for (const el of doc.querySelectorAll('image, use, feImage')) refs.push(el.getAttribute('href') ?? el.getAttribute('xlink:href'));
  const styles = [...doc.querySelectorAll('style')].map((el) => el.textContent);
  styles.push(...[...doc.querySelectorAll('[style]')].map((el) => el.getAttribute('style')));
  for (const css of styles) for (const { start, end } of cssRefs(css)) refs.push(cssUnescape(css.slice(start, end)));

  return {
    title: doc.querySelector('title')?.textContent ?? '',
    description: content('meta[name="description" i]') || content('meta[property="og:description" i]'),
    iconHrefs,
    refs,
    inlineModules: [...doc.querySelectorAll('script[type="module" i]:not([src])')].map((el) => el.textContent),
  };
}

/**
 * C-5 이름·설명·아이콘 결정.
 * @param {{title?: string, description?: string, iconHrefs?: string[]}} html
 * @param {{fallbackName?: string, paths: string[], entry?: string}} ctx
 * @returns {{name: string, description: string, iconPath: string | null}}
 */
export function deriveMeta(html, { fallbackName = '', paths, entry = 'index.html' }) {
  const name = clean(html.title, NAME_MAX) || clean(fallbackName, NAME_MAX) || DEFAULT_NAME;
  const description = clean(html.description, DESCRIPTION_MAX);

  const exact = new Set(paths);
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const find = (p) => (exact.has(p) ? p : lower.get(p.toLowerCase()) ?? null);
  const isImage = (p) => mimeOf(p)?.startsWith('image/');

  let iconPath = null;
  for (const href of html.iconHrefs ?? []) {
    if (classifyRef(href ?? '') !== 'local') continue;
    const r = resolveRef(href, entry);
    const p = r && find(r.path);
    if (p && isImage(p)) {
      iconPath = p;
      break;
    }
  }
  iconPath ??= ICON_FALLBACKS.map(find).find(Boolean) ?? null;
  return { name, description, iconPath };
}

/** C-6 외부 호스트 목록 (중복 제거, 최대 10개) */
export function externalHostsOf(refs, more = []) {
  const hosts = new Set();
  for (const raw of refs) {
    if (typeof raw !== 'string' || classifyRef(raw) !== 'external') continue;
    const h = externalHost(raw);
    if (h) hosts.add(h);
  }
  for (const h of more) hosts.add(h);
  return [...hosts].slice(0, EXTERNAL_MAX);
}
