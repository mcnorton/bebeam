// 런타임 치환 헬퍼 (ARCHITECTURE §4.2, §4.3)
//   host가 각 함수의 소스(Function.prototype.toString)를 srcdoc의 bootstrap 스크립트에 인라인한다.
//   그래서 각 함수는 자기 완결적이어야 한다: 모듈 스코프 변수를 쓰지 않고, 다른 헬퍼는
//   같은 이름의 전역(cssRefs 등)으로만 부른다. 같은 이유로 닫는 script 태그 문자열을 넣지 않는다.
// Node에서는 일반 모듈로 import해 테스트한다.

import { cssRefs } from '../installer/rewrite-plan.js';

export { cssRefs };

/**
 * 앱 기준 경로 해석. 가상 base 밖(외부 URL)이나 data:/blob:/# 은 null.
 * @param {string} ref
 * @param {string} from 참조하는 파일 경로
 * @param {string} vbase 가상 base URL (https://app.toybox.invalid/)
 * @returns {string | null}
 */
export function resolveVirtual(ref, from, vbase) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (!s || s[0] === '#') return null;
  let u;
  try {
    u = new URL(s, vbase + from);
  } catch {
    return null;
  }
  if (u.origin !== new URL(vbase).origin) return null;
  try {
    return decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
}

/**
 * 위치 기반 치환.
 * @param {string} text
 * @param {{start: number, end: number}[]} edits
 * @param {(edit: object) => string | null} replace null이면 그대로 둔다
 */
export function applyEdits(text, edits, replace) {
  // 범위를 벗어나거나 앞 edit과 겹치는 edit은 버린다 (plan과 파일이 어긋난 경우). 먼저 시작한 쪽을 남긴다
  const valid = [...(edits || [])]
    .filter((ed) => ed.start >= 0 && ed.end >= ed.start && ed.end <= text.length)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let end = -1;
  for (const ed of valid) {
    if (ed.start < end) continue;
    kept.push(ed);
    end = ed.end;
  }
  // 뒤에서부터 적용해 앞쪽 위치가 밀리지 않게 한다
  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const ed = kept[i];
    const rep = replace(ed);
    if (rep != null) out = out.slice(0, ed.start) + rep + out.slice(ed.end);
  }
  return out;
}

/**
 * plan이 없는 CSS(인라인 <style>, style 속성)의 url()·@import를 치환한다.
 * #fragment는 남긴다.
 * @param {string} css
 * @param {(ref: string) => string | null} urlFor 원문 참조 → blob URL
 */
export function rewriteCssText(css, urlFor) {
  const edits = cssRefs(css).map((r) => {
    const raw = css.slice(r.start, r.end);
    const hash = raw.indexOf('#');
    return { start: r.start, end: hash < 0 ? r.end : r.start + hash, raw: hash < 0 ? raw : raw.slice(0, hash) };
  });
  return applyEdits(css, edits, (ed) => urlFor(ed.raw));
}

/**
 * srcset 값의 URL 부분만 치환한다.
 * @param {string} value
 * @param {(ref: string) => string | null} urlFor
 */
export function rewriteSrcset(value, urlFor) {
  return String(value)
    .split(',')
    .map((part) => {
      const m = /^(\s*)(\S+)(.*)$/s.exec(part);
      if (!m) return part;
      return m[1] + (urlFor(m[2]) ?? m[2]) + m[3];
    })
    .join(',');
}

/**
 * 스토리지 shim의 변경을 DATABASE §2.3 배치 형식으로 모은다.
 * clear 이후의 set/remove만 남기고, 같은 키의 set과 remove는 마지막 것만 남긴다.
 */
export function createStorageBatcher() {
  let batch = null;
  // set은 프로토타입이 없는 객체: '__proto__' 같은 키도 일반 키로 저장된다
  const ensure = () => (batch ??= { set: Object.create(null), remove: [], clear: false });
  return {
    set(k, v) {
      const b = ensure();
      b.set[k] = v;
      b.remove = b.remove.filter((x) => x !== k);
    },
    remove(k) {
      const b = ensure();
      delete b.set[k];
      if (!b.remove.includes(k)) b.remove.push(k);
    },
    clear() {
      batch = { set: Object.create(null), remove: [], clear: true };
    },
    /** 모인 배치를 꺼낸다. 없으면 null */
    take() {
      const b = batch;
      batch = null;
      return b;
    },
  };
}
