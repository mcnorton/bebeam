// 사용자 설정 (IndexedDB meta 스토어): 내 이름, 같은 이름의 앱을 추가할 때의 처리

import { getMeta, setMeta, listApps } from './db.js';
import { indianName, cleanUserName } from './names.js';
import { planDuplicate } from './installer/duplicates.js';

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

/** 설치 확인 화면용: 설정의 같은 이름 처리와 그 계획. 둘 다 install()의 policy·expect로 넘긴다 */
export async function previewDuplicate(db, name) {
  const policy = await getDuplicatePolicy(db);
  return { policy, plan: planDuplicate(await listApps(db), name, policy) };
}

/** @param {{userName: string, duplicatePolicy: string}} s 이름이 비어 있으면 새로 뽑는다 */
export async function saveSettings(db, { userName, duplicatePolicy }) {
  await setMeta(db, 'userName', cleanUserName(userName) || indianName());
  await setMeta(db, 'duplicatePolicy', duplicatePolicy === DUPLICATE.OVERWRITE ? DUPLICATE.OVERWRITE : DUPLICATE.SEPARATE);
}
