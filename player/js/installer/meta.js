// 메타데이터 추출과 외부 리소스 감지 (SPEC C-5, C-6)
//   readHtml: DOMParser로 index.html을 읽는다 (브라우저 전용, 문서를 플레이어 DOM에 넣지 않는다)
//   deriveMeta, externalHostsOf: 순수 함수 (Node 테스트)

import { classifyRef, cssRefs, cssUnescape, externalHost, resolveRef } from './rewrite-plan.js';
import { mimeOf } from './validate.js';

export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 200;
export const EXTERNAL_MAX = 10;
export const DEFAULT_NAME = '이름 없는 앱';
export const OG_IMAGE_MAX = 2048;
const OG_SEGMENTS_MAX = 16;
const ICON_FALLBACKS = ['favicon.ico', 'favicon.png', 'favicon.svg', 'icon.png'];

// 양방향 제어(이름 위장), 폭 없는 문자·한글 채움 문자·태그 문자(보이지 않는 이름), 공백이 아닌 C0/C1 제어 문자
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

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
 * @returns {{title: string, description: string, iconHrefs: string[], ogImage: string, refs: string[], inlineModules: string[]}}
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
    ogImage: content('meta[property="og:image" i]'),
    refs,
    inlineModules: [...doc.querySelectorAll('script[type="module" i]:not([src])')].map((el) => el.textContent),
  };
}

/** 앱 파일 경로 찾기: 정확히 같은 경로, 없으면 대소문자 무시 */
function finder(paths) {
  const exact = new Set(paths);
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  return (p) => (exact.has(p) ? p : lower.get(p.toLowerCase()) ?? null);
}

const isImage = (p) => mimeOf(p)?.startsWith('image/');

/**
 * og:image를 앱 안의 이미지 파일로 찾는다 (뷰어 배경, W-08). 외부에서 가져오지 않는다.
 *   상대 경로는 진입 HTML 기준으로 푼다. 절대 URL(배포 주소를 적은 경우)은 경로의 뒤쪽부터 맞는 파일을 찾는다:
 *   https://x.io/site/game/og.png → site/game/og.png → game/og.png → og.png
 * @param {string} raw og:image content
 * @param {{paths: string[], entry?: string}} ctx
 * @returns {string | null}
 */
export function findOgImage(raw, { paths, entry = 'index.html' }) {
  // 아주 긴 값으로 설치 분석을 멈추지 못하게 길이와 맞춰 볼 세그먼트 수를 묶는다
  if (typeof raw !== 'string' || !raw.trim() || raw.length > OG_IMAGE_MAX) return null;
  const href = raw.trim();
  const find = finder(paths);
  const pick = (p) => {
    const f = p && find(p);
    return f && isImage(f) ? f : null;
  };
  const kind = classifyRef(href);
  if (kind === 'local') return pick(resolveRef(href, entry)?.path);
  if (kind !== 'external') return null;
  let segments;
  try {
    const u = new URL(href, 'https://base.invalid/'); // // 로 시작하는 주소도 푼다
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    segments = decodeURIComponent(u.pathname).split('/').filter(Boolean).slice(-OG_SEGMENTS_MAX);
  } catch {
    return null;
  }
  for (let i = 0; i < segments.length; i++) {
    const p = pick(segments.slice(i).join('/'));
    if (p) return p;
  }
  return null;
}

/**
 * C-5 이름·설명·아이콘 결정, 뷰어 배경(og:image)
 * @param {{title?: string, description?: string, iconHrefs?: string[], ogImage?: string}} html
 * @param {{fallbackName?: string, paths: string[], entry?: string}} ctx
 * @returns {{name: string, description: string, iconPath: string | null, ogImagePath: string | null}}
 */
export function deriveMeta(html, { fallbackName = '', paths, entry = 'index.html' }) {
  const name = clean(html.title, NAME_MAX) || clean(fallbackName, NAME_MAX) || DEFAULT_NAME;
  const description = clean(html.description, DESCRIPTION_MAX);
  const find = finder(paths);

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
  return { name, description, iconPath, ogImagePath: findOgImage(html.ogImage, { paths, entry }) };
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
