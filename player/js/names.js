// 내 이름 (설정): 비어 있으면 인디언식 이름을 무작위로 만든다.
//   규칙: 태어난 해 끝자리(수식어) + 달(주어) + 날(술어). 예: 4 · 8월 · 22일 → 붉은 노을의 노래
//   생일을 묻지 않고 세 표에서 무작위로 고른다.

import { clean } from './installer/meta.js';

/** 보낸 사람 이름 상한 (글자). QR META에는 UTF-8 90바이트까지 싣는다 (transfer/beam.js SENDER_MAX) */
export const USER_NAME_MAX = 30;

const MODIFIERS = ['백색', '푸른', '어두운', '조용한', '붉은', '노란', '파란', '검은', '하얀', '황금빛'];
const SUBJECTS = ['늑대', '태양', '양', '매', '황소', '구름', '바람', '노을', '달빛', '웅덩이', '푸른산', '바람'];
/** '~'는 주어 자리. '와(과)'·'은(는)'은 주어의 받침에 맞춰 고른다 */
const PREDICATES = [
  '~와(과) 함께 춤을', '~의 유령', '~의 고향', '~의 전사', '~은(는) 맨날 잠만 잔다', '~의 개인기', '~의 방패',
  '~의 가치', '~의 낙엽', '~의 파수꾼', '~의 무기', '~의 안개', '~의 눈물', '~의 증인', '~의 불꽃', '~의 심판',
  '~의 보물', '~의 맹세', '~의 죽음', '~의 아래에서', '~의 그림자', '~의 노래', '~의 행진', '~의 태양',
  '~의 미소', '~의 일격', '~의 기상', '~의 은총', '~의 환생', '~의 영혼', '~의 고향',
];

/** 마지막 글자가 받침 있는 한글이면 true */
export function hasBatchim(word) {
  const s = String(word).trimEnd();
  const code = s.codePointAt(s.length - 1) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

/** 수식어·주어·술어 번호(0부터)로 이름을 만든다 */
export function composeName(year, month, day) {
  const subject = SUBJECTS[month];
  const b = hasBatchim(subject);
  const predicate = PREDICATES[day]
    .replace('와(과)', b ? '과' : '와')
    .replace('은(는)', b ? '은' : '는')
    .replace('~', subject);
  return `${MODIFIERS[year]} ${predicate}`;
}

/** @param {() => number} [rand] 0 이상 1 미만 */
export function indianName(rand = Math.random) {
  const pick = (n) => Math.min(n - 1, Math.floor(rand() * n));
  return composeName(pick(MODIFIERS.length), pick(SUBJECTS.length), pick(PREDICATES.length));
}

/** 입력·수신한 이름 정리: 보이지 않는 문자 제거, 공백 정리, 30자 */
export function cleanUserName(name) {
  return clean(name, USER_NAME_MAX);
}
