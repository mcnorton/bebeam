// 설치 파일 검증 (SPEC C-2~C-4)
//   경로 정규화와 거부 → 항상 제외 → 허용 목록 → 단일 상위 폴더 제거 → 상한 → index.html 확인
// DOM 비의존 순수 모듈.

export const LIMITS = Object.freeze({
  totalSize: 50 * 1024 * 1024,
  fileCount: 1000,
  fileSize: 20 * 1024 * 1024,
  pathLength: 255,
});

export const ENTRY = 'index.html';

/** C-2 허용 목록. MIME은 확장자로만 결정한다 */
export const MIME = Object.freeze({
  html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
});

export class InstallError extends Error {
  /** @param {string} code @param {string} message @param {string} [detail] */
  constructor(code, message, detail) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.detail = detail;
  }
}

/** @returns {string | null} 소문자 확장자 */
export function extOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

export function mimeOf(path) {
  return MIME[extOf(path)] ?? null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // C0, DEL, C1

/**
 * C-4 경로 정규화. 디렉터리 항목(끝이 /)은 null, 거부 대상이면 InstallError.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizePath(raw) {
  if (typeof raw !== 'string') throw new InstallError('bad-path', '잘못된 파일 경로가 있습니다', String(raw));
  if (CONTROL.test(raw)) throw new InstallError('bad-path', '잘못된 파일 경로가 있습니다', raw);
  let p = raw.replace(/\\/g, '/').normalize('NFC');
  // UNC(//server)는 앞의 / 를 지우기 전에, 드라이브 문자(C:)는 지운 뒤에 본다 ('/C:/x' 우회 방지)
  if (p.startsWith('//') || /^\/*[a-zA-Z]:/.test(p)) {
    throw new InstallError('bad-path', '절대 경로가 들어 있는 파일은 설치할 수 없습니다', raw);
  }
  if (p.endsWith('/')) return null;
  p = p.replace(/^\/+/, '');
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new InstallError('bad-path', '상위 폴더(..)를 가리키는 파일은 설치할 수 없습니다', raw);
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** C-2 항상 제외: 점으로 시작하는 파일/폴더, node_modules, __MACOSX, Thumbs.db */
export function isAlwaysExcluded(path) {
  return path.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === '__MACOSX' || seg === 'Thumbs.db');
}

/** C-4 단일 상위 폴더 제거 (반복). 제거한 접두어를 돌려준다 */
export function stripSingleRoot(paths) {
  let prefix = '';
  let list = paths;
  for (;;) {
    if (!list.length || list.includes(ENTRY)) break;
    const tops = new Set(list.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : null)));
    if (tops.size !== 1 || tops.has(null)) break;
    const [top] = tops;
    prefix += top + '/';
    list = list.map((p) => p.slice(top.length + 1));
  }
  return prefix;
}

/**
 * @template {{path: string, size: number}} T
 * @param {T[]} entries 원본 경로와 크기 (blob 등 나머지 필드는 그대로 전달된다)
 * @returns {{files: (T & {mime: string})[], excludedCount: number, rootPrefix: string, totalSize: number}}
 */
export function validateEntries(entries) {
  const kept = [];
  let excludedCount = 0;
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (path === null) continue;
    if (isAlwaysExcluded(path)) continue;
    const mime = mimeOf(path);
    if (!mime) {
      excludedCount++;
      continue;
    }
    kept.push({ ...entry, path, mime });
  }

  const rootPrefix = stripSingleRoot(kept.map((f) => f.path));
  if (rootPrefix) for (const f of kept) f.path = f.path.slice(rootPrefix.length);

  if (kept.length > LIMITS.fileCount) {
    throw new InstallError('too-many-files', `파일이 너무 많습니다 (최대 ${LIMITS.fileCount}개)`, String(kept.length));
  }
  const seen = new Set();
  let totalSize = 0;
  for (const f of kept) {
    if (seen.has(f.path)) throw new InstallError('duplicate-path', '같은 경로의 파일이 두 개 있습니다', f.path);
    seen.add(f.path);
    if (f.path.length > LIMITS.pathLength) {
      throw new InstallError('path-too-long', `파일 경로가 너무 깁니다 (최대 ${LIMITS.pathLength}자)`, f.path);
    }
    if (f.size > LIMITS.fileSize) {
      throw new InstallError('file-too-large', `파일 하나의 크기가 너무 큽니다 (최대 ${LIMITS.fileSize / 1024 / 1024}MB)`, f.path);
    }
    totalSize += f.size;
  }
  if (totalSize > LIMITS.totalSize) {
    throw new InstallError('too-large', `앱 크기가 너무 큽니다 (최대 ${LIMITS.totalSize / 1024 / 1024}MB)`, String(totalSize));
  }
  if (!seen.has(ENTRY)) throw new InstallError('no-index', 'index.html을 찾을 수 없습니다');

  return { files: kept, excludedCount, rootPrefix, totalSize };
}
