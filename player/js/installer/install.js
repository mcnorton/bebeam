// 설치 파이프라인 (SPEC F-02, DATABASE §4, §6)
//   analyze: 검증 → 메타 → rewrite plan → SHA-256. 모두 트랜잭션 밖에서 끝낸다.
//   install: 새 ID를 발급하고 apps·files를 단일 트랜잭션으로 기록한다.
//            같은 이름의 앱이 있으면 설정에 따라 번호를 붙여 따로 추가하거나, 가장 최근 앱의 파일을 바꾼다(저장 데이터 유지).

import { appRange, done, request } from '../db.js';
import { allocateAppId } from '../ids.js';
import { readHtml, deriveMeta, externalHostsOf, findOgImage } from './meta.js';
import { buildRewritePlan } from './rewrite-plan.js';
import { validateEntries, InstallError, ENTRY } from './validate.js';
import { planDuplicate } from './duplicates.js';

const STEPS = ['validate', 'meta', 'plan', 'hash'];
const ADD_RETRIES = 3;

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {Blob | BufferSource} data */
export async function sha256(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

/** 정렬된 (path, sha256) 목록의 SHA-256 (DATABASE §2.1) */
export function contentHash(files) {
  const lines = files.map((f) => `${f.path}\0${f.sha256}\n`).sort();
  return sha256(new TextEncoder().encode(lines.join('')));
}

/**
 * @param {{name: string, entries: {path: string, size: number, blob: Blob}[]}} source source.js 결과
 * @param {{onStep?: (step: string, index: number, total: number) => void, Parser?: typeof DOMParser}} [options]
 */
export async function analyze(source, { onStep, Parser } = {}) {
  const step = (s) => onStep?.(s, STEPS.indexOf(s), STEPS.length);

  step('validate');
  const { files, excludedCount, totalSize } = validateEntries(source.entries);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = files.map((f) => f.path);

  step('meta');
  let html;
  try {
    html = readHtml(await byPath.get(ENTRY).blob.text(), Parser);
  } catch (err) {
    throw new InstallError('bad-html', 'index.html을 읽을 수 없습니다', err?.message);
  }
  const meta = deriveMeta(html, { fallbackName: source.name, paths });

  step('plan');
  // 모든 HTML 페이지의 인라인 모듈과 외부 참조를 모은다 (내부 링크로 다른 페이지도 렌더링되므로)
  const inlineModules = {};
  const refs = [...html.refs];
  if (html.inlineModules.length) inlineModules[ENTRY] = html.inlineModules;
  const texts = new Map();
  for (const f of files) {
    if (/\.(css|m?js)$/i.test(f.path)) {
      texts.set(f.path, await f.blob.text());
    } else if (/\.html?$/i.test(f.path) && f.path !== ENTRY) {
      try {
        const page = readHtml(await f.blob.text(), Parser);
        if (page.inlineModules.length) inlineModules[f.path] = page.inlineModules;
        refs.push(...page.refs);
      } catch {
        // 진입 페이지가 아니면 설치를 막지 않는다
      }
    }
  }
  const { plan, externalHosts } = await buildRewritePlan({ paths, texts, inlineModules });

  step('hash');
  for (const f of files) f.sha256 = await sha256(f.blob);

  return {
    ...meta,
    entry: ENTRY,
    size: totalSize,
    fileCount: files.length,
    excludedCount,
    externalRefs: externalHostsOf(refs, externalHosts),
    rewritePlan: plan,
    contentHash: await contentHash(files),
    files: files.map(({ path, mime, size, blob, sha256: h }) => ({ path, mime, size, blob, sha256: h })),
  };
}

/**
 * ogImagePath 필드가 생기기 전에 설치된 앱의 og:image를 설치된 파일에서 찾는다 (DATABASE §2)
 * @returns {Promise<string | null>}
 */
export async function findInstalledOgImage(db, app, { Parser } = {}) {
  const store = db.transaction('files').objectStore('files');
  const [keys, entry] = await Promise.all([
    request(store.getAllKeys(appRange(app.id))),
    request(store.get([app.id, app.entry])),
  ]);
  if (!entry?.blob) return null;
  const html = readHtml(await entry.blob.text(), Parser);
  return findOgImage(html.ogImage, { paths: keys.map((k) => k[1]), entry: app.entry });
}

/**
 * 설치된 파일로 rewrite plan을 다시 계산한다 (plan 버전이 바뀐 경우, DATABASE §7).
 * @param {Map<string, {mime: string, blob: Blob}>} files
 * @param {{Parser?: typeof DOMParser}} [options]
 */
export async function replan(files, { Parser } = {}) {
  const texts = new Map();
  const inlineModules = {};
  for (const [path, f] of files) {
    if (/\.(css|m?js)$/i.test(path)) {
      texts.set(path, await f.blob.text());
    } else if (/\.html?$/i.test(path)) {
      try {
        const page = readHtml(await f.blob.text(), Parser);
        if (page.inlineModules.length) inlineModules[path] = page.inlineModules;
      } catch {}
    }
  }
  const { plan } = await buildRewritePlan({ paths: [...files.keys()], texts, inlineModules });
  return plan;
}

/**
 * 남은 공간 확인 (DATABASE §6). 앱 크기 × 1.2보다 작으면 enough = false.
 * estimate를 지원하지 않으면 null.
 */
export async function checkSpace(size) {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {};
    if (!quota) return null;
    return { usage, quota, enough: quota - usage >= size * 1.2 };
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function writeOnce(db, analysis, source, { senderName = null, policy = 'separate', expect = null, overwriteId = null } = {}) {
  const tx = db.transaction(['apps', 'files'], 'readwrite');
  const apps = tx.objectStore('apps');
  const filesStore = tx.objectStore('files');
  const finished = done(tx);
  const written = (async () => {
    const now = Date.now();
    const { files, ...meta } = analysis;
    // 같은 트랜잭션 안에서 목록을 읽어 판단한다 (다른 창이 동시에 추가해도 이름·대상이 어긋나지 않게)
    const all = await request(apps.getAll());
    let plan;
    if (overwriteId) {
      // 정해 둔 앱을 덮어쓴다 (기본 앱 새 판). 그사이 지워졌으면 쓰지 않는다
      const target = all.find((a) => a.id === overwriteId);
      if (!target) throw new InstallError('changed', '덮어쓸 앱이 없습니다');
      plan = { kind: 'overwrite', name: target.name, target };
    } else {
      plan = planDuplicate(all, meta.name, policy);
    }
    // 확인 화면에서 보여준 결과(expect)와 달라졌으면(다른 창이 그사이 추가·삭제) 쓰지 않고 다시 확인받게 한다
    if (expect && (expect.kind !== plan.kind || (expect.target?.id ?? null) !== (plan.target?.id ?? null))) {
      throw new InstallError('changed', '그사이 앱 목록이 바뀌었습니다. 다시 추가해 주세요.');
    }
    const content = {
      description: meta.description,
      iconPath: meta.iconPath,
      ogImagePath: meta.ogImagePath,
      entry: meta.entry,
      source,
      senderName: source === 'qr' ? senderName : null,
      size: meta.size,
      fileCount: meta.fileCount,
      excludedCount: meta.excludedCount,
      externalRefs: meta.externalRefs,
      rewritePlan: meta.rewritePlan,
      contentHash: meta.contentHash,
      status: 'ok',
      error: null,
      updatedAt: now,
    };
    if (plan.kind === 'overwrite') {
      // 덮어쓰기: ID·이름·추가 시각·appStorage는 그대로, 파일과 앱 정보만 새것으로
      const id = plan.target.id;
      const app = { ...plan.target, ...content };
      filesStore.delete(appRange(id));
      for (const f of files) filesStore.add({ ...f, appId: id });
      apps.put(app);
      return app;
    }
    const id = await allocateAppId(async (x) => (await request(apps.getKey(x))) !== undefined);
    const app = {
      id,
      name: plan.name,
      originalName: meta.name,
      ...content,
      createdAt: now,
      lastRunAt: null,
    };
    apps.add(app);
    for (const f of files) filesStore.add({ ...f, appId: id });
    return app;
  })();
  // ID 발급이 실패하면 트랜잭션을 abort해 아무것도 남기지 않는다
  written.catch(() => {
    try {
      tx.abort();
    } catch {}
  });
  return Promise.all([written, finished]).then(([app]) => app);
}

/**
 * @param {IDBDatabase} db
 * @param {Awaited<ReturnType<typeof analyze>>} analysis
 * @param {'folder' | 'zip' | 'qr' | 'builtin'} source
 * @param {{senderName?: string | null, policy?: 'separate' | 'overwrite', expect?: ReturnType<typeof planDuplicate>, overwriteId?: string | null}} [options]
 *   QR로 받은 앱의 보낸 사람, 같은 이름 처리, 확인 화면에서 보여준 계획(다르면 InstallError 'changed'),
 *   이름과 상관없이 덮어쓸 앱 ID(없으면 InstallError 'changed')
 * @returns {Promise<object>} 기록한 apps 레코드
 */
export async function install(db, analysis, source, options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeOnce(db, analysis, source, options);
    } catch (err) {
      // 다른 창이 같은 ID를 동시에 쓴 경우만 다시 시도한다
      if (err?.name === 'ConstraintError' && attempt < ADD_RETRIES) continue;
      if (err?.name === 'QuotaExceededError') {
        const space = await checkSpace(analysis.size);
        const detail = space ? ` (사용 중 ${formatBytes(space.usage)} / 가능 ${formatBytes(space.quota)})` : '';
        throw new InstallError('quota', `저장 공간이 부족합니다${detail}`);
      }
      throw err;
    }
  }
}
