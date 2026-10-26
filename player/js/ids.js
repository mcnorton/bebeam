// 8자리 앱 ID (SPEC C-1)
//   10000000–99999999 범위의 숫자 문자열. 충돌하면 다시 뽑는다 (최대 10회).

export const ID_MIN = 10_000_000;
export const ID_MAX = 99_999_999;
export const MAX_TRIES = 10;

const RANGE = ID_MAX - ID_MIN + 1;
// 2^32를 RANGE로 나눈 나머지 구간을 버려 모듈로 편향을 없앤다
const LIMIT = Math.floor(2 ** 32 / RANGE) * RANGE;

/** @returns {string} */
export function randomAppId() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= LIMIT);
  return String(ID_MIN + (a[0] % RANGE));
}

/** @param {unknown} id */
export function isAppId(id) {
  return typeof id === 'string' && /^[1-9]\d{7}$/.test(id);
}

/**
 * 사용 중이지 않은 ID를 고른다. isTaken은 동기 또는 Promise를 반환할 수 있다.
 * @param {(id: string) => boolean | Promise<boolean>} isTaken
 * @param {() => string} [next]
 * @returns {Promise<string>}
 */
export async function allocateAppId(isTaken, next = randomAppId) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const id = next();
    if (!(await isTaken(id))) return id;
  }
  throw new Error('앱 ID를 발급하지 못했습니다');
}
