// 기본 앱 「비빔 비벼보기」 (player/apps/try-bebeam, 사용법 애니메이션)
//   처음 실행 때 한 번 설치한다. 사용자가 지우면 다시 넣지 않고, 설정의 [다시 추가]로만 넣는다.
//   플레이어 버전이 바뀌면 목록에 남아 있을 때만 새 판으로 덮어쓴다(저장 데이터 유지).
//   meta 'guide' = { appId, version }: appId는 설치한 앱, version은 마지막으로 확인한 플레이어 버전
//   앱 폴더는 플레이어 origin의 최상위 페이지로도 열리므로(같은 origin의 1차 코드), 앱의 innerHTML에는 고정 문자열만 넣는다

import { getMeta, setMeta, listApps } from './db.js';
import { analyze, install } from './installer/install.js';
import { VERSION } from '../version.js';

export const GUIDE_DIR = 'apps/try-bebeam/';
/** 앱 파일 목록. tests/builtin.test.js가 폴더 내용과 같은지 확인한다 */
export const GUIDE_FILES = Object.freeze([
  'art.js',
  'fonts/NeoDunggeunmoPro-Regular.woff2',
  'fonts/OFL.txt',
  'icon.png',
  'index.html',
  'main.js',
  'scenes.js',
  'screenshot.png',
  'style.css',
  'text.js',
]);
const KEY = 'guide';

/** SW가 precache한 앱 파일을 읽어 설치 분석까지 한다 */
async function analyzeGuide() {
  const entries = await Promise.all(GUIDE_FILES.map(async (path) => {
    const res = await fetch(new URL(GUIDE_DIR + path, document.baseURI));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const blob = await res.blob();
    return { path, size: blob.size, blob };
  }));
  return analyze({ name: '', entries });
}

async function installFresh(db) {
  const app = await install(db, await analyzeGuide(), 'builtin');
  await setMeta(db, KEY, { appId: app.id, version: VERSION });
  return app;
}

/** 기본 앱이 목록에 있는지 (설정의 [다시 추가] 표시용) */
export async function hasGuide(db) {
  const rec = await getMeta(db, KEY);
  return Boolean(rec?.appId) && (await listApps(db)).some((a) => a.id === rec.appId && a.source === 'builtin');
}

/**
 * 시작할 때 부른다. 새로 설치했거나 덮어썼으면 그 앱 레코드, 할 일이 없으면 null.
 * @param {IDBDatabase} db
 */
export async function ensureGuide(db) {
  const rec = await getMeta(db, KEY);
  if (!rec) return installFresh(db);
  if (rec.version === VERSION) return null;
  // 같은 이름 [덮어쓰기]로 사용자 앱이 그 ID를 물려받았으면 건드리지 않는다
  const current = (await listApps(db)).find((a) => a.id === rec.appId && a.source === 'builtin');
  let app = null;
  if (current) {
    const analysis = await analyzeGuide();
    if (analysis.contentHash !== current.contentHash) {
      app = await install(db, analysis, 'builtin', { overwriteId: current.id });
    }
  }
  await setMeta(db, KEY, { ...rec, version: VERSION });
  return app;
}

/** 설정의 [다시 추가] */
export function restoreGuide(db) {
  return installFresh(db);
}
