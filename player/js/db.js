// IndexedDB "bebeam" 래퍼 (DATABASE §2, §4, §7)
//   트랜잭션 안에서는 같은 트랜잭션의 IDB 요청만 await한다.
//   다른 비동기 작업(해시 계산, Blob 읽기 등)이 끼면 트랜잭션이 자동 커밋되므로 밖에서 미리 끝낸다.

import { isAppId } from './ids.js';

export const DB_NAME = 'bebeam';
export const DB_VERSION = 1;
export const NAME_MAX = 60;

/** 단계별 마이그레이션. oldVersion부터 순서대로 적용한다 (DATABASE §7) */
function upgrade(db, oldVersion, tx) {
  if (oldVersion < 1) {
    const apps = db.createObjectStore('apps', { keyPath: 'id' });
    apps.createIndex('createdAt', 'createdAt');
    const files = db.createObjectStore('files', { keyPath: ['appId', 'path'] });
    files.createIndex('appId', 'appId');
    const storage = db.createObjectStore('appStorage', { keyPath: ['appId', 'key'] });
    storage.createIndex('appId', 'appId');
    const meta = db.createObjectStore('meta', { keyPath: 'key' });
    meta.put({ key: 'schemaVersion', value: 1 });
  }
  // if (oldVersion < 2) { ... }
  tx.objectStore('meta').put({ key: 'schemaVersion', value: DB_VERSION });
}

/**
 * @param {{onBlocked?: () => void, onVersionChange?: () => void}} [hooks]
 *   onBlocked: 다른 창이 이전 버전 연결을 잡고 있음 → "다른 창의 BeBeam을 닫아 주세요"
 *   onVersionChange: 다른 창이 업그레이드를 요청함 → 연결은 여기서 닫고, 새로고침을 안내
 * @returns {Promise<IDBDatabase>}
 */
export function openDb({ onBlocked, onVersionChange } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion, req.transaction);
    req.onblocked = () => onBlocked?.();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
      resolve(db);
    };
  });
}

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 트랜잭션 완료. abort되면 원인 오류(QuotaExceededError 등)로 reject한다.
 * 요청 오류에 preventDefault()를 하면 트랜잭션이 abort되지 않고 커밋되므로 하지 않는다.
 */
export function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

/** 범위 삭제 전에 ID 형식을 확인한다. 잘못된 값(IDBKeyRange 등)이 여러 앱을 지우지 않도록 */
function assertAppId(id) {
  if (!isAppId(id)) throw new TypeError(`잘못된 앱 ID: ${String(id).slice(0, 20)}`);
}

/** 복합 키 [appId, *] 전체 범위. 배열 키는 문자열보다 크므로 [id, []]가 상한이 된다 */
export function appRange(appId) {
  assertAppId(appId);
  return IDBKeyRange.bound([appId], [appId, []]);
}

/** @returns {Promise<object[]>} 최근 추가 순 */
export async function listApps(db) {
  const tx = db.transaction('apps');
  const apps = await request(tx.objectStore('apps').index('createdAt').getAll());
  return apps.reverse();
}

export function getApp(db, id) {
  return request(db.transaction('apps').objectStore('apps').get(id));
}

/** 이름 바꾸기 (SPEC F-03): 앞뒤 공백 제거 후 1–60자 */
export function normalizeName(name) {
  const s = String(name ?? '').trim();
  const len = [...s].length;
  return len >= 1 && len <= NAME_MAX ? s : null;
}

/**
 * apps 레코드 일부 갱신. 없는 앱이면 null.
 * @param {(app: object) => object} patch
 */
async function updateApp(db, id, patch) {
  const tx = db.transaction('apps', 'readwrite');
  const store = tx.objectStore('apps');
  const app = await request(store.get(id));
  if (!app) return null;
  const next = { ...app, ...patch(app) };
  store.put(next);
  await done(tx);
  return next;
}

export function renameApp(db, id, name) {
  const n = normalizeName(name);
  if (n === null) return Promise.reject(new RangeError(`이름은 1–${NAME_MAX}자여야 합니다`));
  return updateApp(db, id, () => ({ name: n, updatedAt: Date.now() }));
}

export function touchLastRun(db, id) {
  return updateApp(db, id, () => ({ lastRunAt: Date.now() }));
}

/**
 * plan 버전이 바뀌었을 때 다시 계산한 plan을 저장한다 (DATABASE §7). 파일은 그대로 둔다.
 * contentHash: 계산에 쓴 파일의 해시. 그사이 덮어쓰기로 파일이 바뀌었으면 저장하지 않는다
 */
export function savePlan(db, id, rewritePlan, contentHash) {
  return updateApp(db, id, (app) => (app.contentHash === contentHash ? { rewritePlan } : {}));
}

/** 뷰어 배경(og:image) 경로를 저장한다. 없으면 null (다시 찾지 않는다, DATABASE §2). contentHash는 savePlan과 같다 */
export function saveOgImage(db, id, ogImagePath, contentHash) {
  return updateApp(db, id, (app) => (app.contentHash === contentHash ? { ogImagePath } : {}));
}

/** 초기화: 앱 저장 데이터만 삭제한다. 파일은 유지 */
export function clearAppStorage(db, id) {
  assertAppId(id);
  const tx = db.transaction('appStorage', 'readwrite');
  tx.objectStore('appStorage').delete(appRange(id));
  return done(tx);
}

/** 삭제: apps, files, appStorage를 단일 트랜잭션으로 */
export function deleteApp(db, id) {
  assertAppId(id);
  const tx = db.transaction(['apps', 'files', 'appStorage'], 'readwrite');
  tx.objectStore('apps').delete(id);
  tx.objectStore('files').delete(appRange(id));
  tx.objectStore('appStorage').delete(appRange(id));
  return done(tx);
}

/**
 * 실행 로드: 한 readonly 트랜잭션에서 모두 읽는다.
 * @returns {Promise<{app: object, files: Map<string, {mime: string, blob: Blob}>, storage: Record<string, string>} | null>}
 */
export async function loadForRun(db, id) {
  const tx = db.transaction(['apps', 'files', 'appStorage']);
  const [app, files, entries] = await Promise.all([
    request(tx.objectStore('apps').get(id)),
    request(tx.objectStore('files').getAll(appRange(id))),
    request(tx.objectStore('appStorage').getAll(appRange(id))),
  ]);
  if (!app) return null;
  const storage = Object.create(null);
  for (const { key, value } of entries) storage[key] = value;
  return {
    app,
    files: new Map(files.map((f) => [f.path, { mime: f.mime, blob: f.blob }])),
    storage,
  };
}

/**
 * shim의 STORAGE_BATCH를 하나의 트랜잭션으로 반영한다 (DATABASE §2.3).
 * clear → remove → set 순서로 적용한다. 형식이 틀리면 아무것도 반영하지 않는다.
 * @param {{set?: Record<string, string>, remove?: string[], clear?: boolean}} batch
 */
export function applyStorageBatch(db, id, { set = {}, remove = [], clear = false } = {}) {
  assertAppId(id);
  const entries = set && typeof set === 'object' ? Object.entries(set) : null;
  if (!entries || !entries.every(([, v]) => typeof v === 'string')
    || !Array.isArray(remove) || !remove.every((k) => typeof k === 'string') || typeof clear !== 'boolean') {
    return Promise.reject(new TypeError('잘못된 저장소 배치'));
  }
  const tx = db.transaction('appStorage', 'readwrite');
  const finished = done(tx);
  const store = tx.objectStore('appStorage');
  try {
    if (clear) store.delete(appRange(id));
    for (const key of remove) store.delete([id, key]);
    for (const [key, value] of entries) store.put({ appId: id, key, value });
  } catch (err) {
    tx.abort();
    finished.catch(() => {});
    return Promise.reject(err);
  }
  return finished;
}

export async function getMeta(db, key) {
  const row = await request(db.transaction('meta').objectStore('meta').get(key));
  return row?.value;
}

export function setMeta(db, key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  return done(tx);
}
