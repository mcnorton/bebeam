// 설치 원본 읽기: 폴더(webkitdirectory) 또는 zip → {path, size, blob}[]
//   zip은 fflate로 스트리밍 해제하며 zip bomb 상한을 검사한다 (ARCHITECTURE §6 T6).
//   zip 항목은 여기서 먼저 정규화해(C-4, 거부 대상이면 즉시 오류) 제외 대상을 판정한다.
//   허용 목록·상한·index.html 검사는 validate.js가 맡는다.

import { Unzip, UnzipInflate } from '../../vendor/fflate/fflate.js';
import { InstallError, LIMITS, isAlwaysExcluded, normalizePath } from './validate.js';

export const ZIP_LIMITS = Object.freeze({
  totalSize: LIMITS.totalSize,
  ratio: 100,
  /** 비율 검사는 이 크기를 넘은 뒤부터 한다 (작은 zip의 높은 압축률은 정상) */
  ratioFloor: 1024 * 1024,
  /** 디렉터리·제외 대상을 포함한 원본 항목 수 */
  entries: LIMITS.fileCount * 5,
  /** zip 파일 자체의 크기. 해제 전 데이터가 메모리에 머무를 수 있으므로 입력도 묶는다 */
  zipSize: LIMITS.totalSize * 2,
  /** 제외 대상(__MACOSX, .git 등)을 풀어서 버린 바이트 */
  discarded: LIMITS.totalSize * 4,
});

/** push 한 번의 압축 해제 출력은 최대 약 1032배다. 조각을 작게 해 순간 메모리를 묶는다 */
const CHUNK = 16 * 1024;

/** 폴더 이름이나 zip 이름에서 앱 이름 후보를 만든다 (C-5) */
export function baseName(name) {
  return String(name ?? '').replace(/\.zip$/i, '').trim();
}

/**
 * <input webkitdirectory>의 FileList.
 * @param {ArrayLike<File>} fileList
 * @returns {{name: string, entries: {path: string, size: number, blob: Blob}[]}}
 */
export function fromFolder(fileList) {
  const files = Array.from(fileList);
  if (files.length > ZIP_LIMITS.entries) throw new InstallError('too-many-files', '폴더 안의 파일이 너무 많습니다');
  const entries = files.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, blob: f }));
  const first = entries[0]?.path ?? '';
  return { name: first.includes('/') ? first.slice(0, first.indexOf('/')) : '', entries };
}

/**
 * zip 해제. 누적 크기, 압축률, 항목 수가 상한을 넘으면 즉시 중단한다.
 * @param {Blob} zip
 * @param {{name?: string, limits?: typeof ZIP_LIMITS, onProgress?: (read: number, total: number) => void}} [options]
 * @returns {Promise<{name: string, entries: {path: string, size: number, blob: Blob}[]}>}
 */
export async function fromZip(zip, { name = zip.name, limits = ZIP_LIMITS, onProgress } = {}) {
  if (zip.size > limits.zipSize) {
    throw new InstallError('too-large', `zip 파일이 너무 큽니다 (최대 ${limits.zipSize / 1024 / 1024}MB)`);
  }
  // 로컬 파일 헤더 'PK\x03\x04'로 시작해야 한다 (빈 zip이나 다른 형식은 거부)
  const sig = new Uint8Array(await zip.slice(0, 4).arrayBuffer());
  if (sig.length < 4 || sig[0] !== 0x50 || sig[1] !== 0x4b || sig[2] !== 3 || sig[3] !== 4) {
    throw new InstallError('bad-zip', 'zip 파일이 아니거나 비어 있습니다');
  }
  const entries = [];
  let failure = null;
  let entryCount = 0;
  let out = 0;
  let discarded = 0;

  const fail = (err) => {
    failure ??= err;
    throw failure;
  };
  const guard = (n) => {
    out += n;
    if (out > limits.totalSize) {
      fail(new InstallError('too-large', `앱 크기가 너무 큽니다 (최대 ${limits.totalSize / 1024 / 1024}MB)`));
    }
    if (out > limits.ratioFloor && out > zip.size * limits.ratio) {
      fail(new InstallError('zip-bomb', '압축 비율이 비정상적인 zip 파일입니다'));
    }
  };
  const start = (file) => {
    try {
      file.start();
    } catch (err) {
      fail(err instanceof InstallError ? err : new InstallError('bad-zip', '지원하지 않는 zip 형식입니다', err.message));
    }
  };

  const unzip = new Unzip((file) => {
    if (++entryCount > limits.entries) fail(new InstallError('too-many-files', 'zip 안의 항목이 너무 많습니다'));
    // 거부 대상 경로('..', 절대경로, 제어문자)는 제외 폴더 안에 있어도 여기서 바로 오류가 된다
    const path = normalizePath(file.name);
    if (path === null && !file.name.endsWith('/')) return; // 이름 없는 항목
    if (path === null || isAlwaysExcluded(path)) {
      // 시작하지 않은 항목의 압축 데이터는 fflate가 끝까지 쥐고 있으므로, 풀어서 버린다
      file.ondata = (err, data) => {
        if (failure) return;
        if (err) fail(new InstallError('bad-zip', 'zip 파일을 풀 수 없습니다', err.message));
        discarded += data.length;
        if (discarded > limits.discarded) fail(new InstallError('zip-bomb', '압축 비율이 비정상적인 zip 파일입니다'));
      };
      start(file);
      return;
    }
    const chunks = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) fail(new InstallError('bad-zip', 'zip 파일을 풀 수 없습니다', err.message));
      size += data.length;
      guard(data.length);
      chunks.push(data);
      if (final) entries.push({ path, size, blob: new Blob(chunks) });
    };
    start(file);
  });
  unzip.register(UnzipInflate);

  const reader = zip.stream().getReader();
  let read = 0;
  try {
    // 마지막 조각에 final=true를 주기 위해 한 조각씩 늦게 넣는다
    let pending = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(pending ?? new Uint8Array(0), true);
        break;
      }
      for (let i = 0; i < value.length; i += CHUNK) {
        if (pending) unzip.push(pending, false);
        pending = value.subarray(i, i + CHUNK);
      }
      read += value.length;
      onProgress?.(read, zip.size);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    if (failure) throw failure;
    if (err instanceof InstallError) throw err;
    throw new InstallError('bad-zip', 'zip 파일을 풀 수 없습니다', err?.message);
  }
  if (failure) throw failure;
  return { name: baseName(name), entries };
}
