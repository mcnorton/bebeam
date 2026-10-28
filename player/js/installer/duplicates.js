// 같은 이름의 앱 (설정 '같은 이름의 앱을 추가할 때', SPEC F-02)
//   같은 이름 = 설치할 때의 원래 제목(originalName)이 같은 앱. 사용자가 이름을 바꿔도 원래 제목으로 맞춘다.
//   따로 추가: 원본은 번호 없이 두고, 다음부터 '이름 (1)', '이름 (2)'… 큰 번호가 최신이다.
//   덮어쓰기: 같은 이름 중 가장 최근에 추가한 앱을 바꾼다.

import { NAME_MAX } from './meta.js';

/** @param {readonly {originalName?: string, name: string, createdAt: number}[]} apps */
export function findSameName(apps, originalName) {
  return apps.filter((a) => (a.originalName ?? a.name) === originalName);
}

/** 같은 이름 중 가장 최근에 추가한 앱 (없으면 null) */
export function latestSameName(apps, originalName) {
  let latest = null;
  for (const a of findSameName(apps, originalName)) if (!latest || a.createdAt > latest.createdAt) latest = a;
  return latest;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 따로 추가할 때의 새 이름. 같은 이름이 없으면 base 그대로.
 * 번호는 지금 있는 'base (n)'의 가장 큰 n + 1 (없으면 1). 60자를 넘으면 base를 줄인다.
 */
export function numberedName(apps, base) {
  const same = findSameName(apps, base);
  if (same.length === 0) return base;
  const re = new RegExp(`^${escapeRe(base)} \\((\\d+)\\)$`);
  let max = 0;
  for (const a of apps) {
    const m = re.exec(a.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = Math.max(max, same.length - 1) + 1;
  const suffix = ` (${n})`;
  const chars = [...base];
  const room = NAME_MAX - suffix.length;
  return (chars.length > room ? chars.slice(0, room).join('').trimEnd() : base) + suffix;
}

/**
 * 설치 결과 미리 보기 겸 계획. 설치 확인 화면과 install()이 같은 판단을 쓴다.
 * @param {'separate' | 'overwrite'} policy
 * @returns {{kind: 'new' | 'separate' | 'overwrite', name: string, target: object | null}}
 */
export function planDuplicate(apps, originalName, policy) {
  const latest = latestSameName(apps, originalName);
  if (!latest) return { kind: 'new', name: originalName, target: null };
  if (policy === 'overwrite') return { kind: 'overwrite', name: latest.name, target: latest };
  return { kind: 'separate', name: numberedName(apps, originalName), target: null };
}
