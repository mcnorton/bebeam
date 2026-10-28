// 사용자 설정 (IndexedDB meta 스토어): 내 이름, 같은 이름의 앱을 추가할 때의 처리

import { getMeta, setMeta } from './db.js';
import { indianName, cleanUserName } from './names.js';

export const DUPLICATE = Object.freeze({ SEPARATE: 'separate', OVERWRITE: 'overwrite' });

/** 내 이름. 없으면 인디언식 이름을 한 번 만들어 저장한다 */
export async function getUserName(db) {
  const saved = cleanUserName(await getMeta(db, 'userName'));
  if (saved) return saved;
  const name = indianName();
  await setMeta(db, 'userName', name);
  return name;
}

export async function getDuplicatePolicy(db) {
  return (await getMeta(db, 'duplicatePolicy')) === DUPLICATE.OVERWRITE ? DUPLICATE.OVERWRITE : DUPLICATE.SEPARATE;
}

/** @param {{userName: string, duplicatePolicy: string}} s 이름이 비어 있으면 새로 뽑는다 */
export async function saveSettings(db, { userName, duplicatePolicy }) {
  await setMeta(db, 'userName', cleanUserName(userName) || indianName());
  await setMeta(db, 'duplicatePolicy', duplicatePolicy === DUPLICATE.OVERWRITE ? DUPLICATE.OVERWRITE : DUPLICATE.SEPARATE);
}
