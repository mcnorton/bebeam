// 전송 파이프라인 (TASK T3.7, T3.8)
//   송신: files → zip(deflate) → (broadcast.js가 분수 부호로 QR 프레임을 만든다)
//   수신: (broadcast.js가 조립·해시 검증) → zip 해제 → 검증(C-2~C-6) → 설치(source: 'qr', 새 ID)
// 앱 데이터(appStorage)는 보내지 않는다 (SPEC F-05 규칙 8).

import { zipSync } from '../../vendor/fflate/fflate.js';
import { loadForRun } from '../db.js';
import { fromZip } from '../installer/source.js';
import { analyze, install } from '../installer/install.js';
import { extOf } from '../installer/validate.js';

/** 이미 압축된 형식은 다시 압축하지 않는다 (시간만 들고 크기는 그대로) */
const STORED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'mp4', 'webm', 'woff', 'woff2']);

/** 전송 권장 크기 (압축 후, SPEC C-3). 넘으면 예상 시간을 경고한다 */
export const TRANSFER_WARN = 2 * 1024 * 1024;
/** 예상 시간 계산용 보수적 처리량: 보통 속도(v25, 10fps) 이론 약 10 KB/s에서 인식 실패를 뺀 값 (R4 §2.1, 실측 대기) */
export const ESTIMATE_BPS = 6 * 1024;

export function estimateSeconds(bytes) {
  return Math.ceil(bytes / ESTIMATE_BPS);
}

/** "약 N분" / "약 N초" */
export function formatEstimate(seconds) {
  if (seconds < 60) return `약 ${Math.max(10, Math.round(seconds / 10) * 10)}초`;
  return `약 ${Math.ceil(seconds / 60)}분`;
}

/**
 * 설치된 앱을 전송용 zip으로 묶는다.
 * @returns {Promise<{zip: Uint8Array, name: string, fileCount: number}>}
 */
export async function packApp(db, appId) {
  const data = await loadForRun(db, appId);
  if (!data) throw new Error('앱을 찾을 수 없습니다');
  const entries = {};
  for (const [path, f] of data.files) {
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    entries[path] = STORED.has(extOf(path)) ? [bytes, { level: 0 }] : [bytes, { level: 6 }];
  }
  return { zip: zipSync(entries), name: data.app.name, fileCount: data.files.size };
}

/**
 * 받은 zip을 일반 설치 경로로 분석한다(C-2~C-6). 검증에 실패하면 InstallError.
 * 설치 동의 화면은 송신자가 META로 주장한 값이 아니라 이 분석 결과(실제 이름·파일 수·크기)를 보여준다.
 * @param {Uint8Array} zip 수신자가 SHA-256까지 확인한 zip
 * @param {string} name META의 이름 (index.html에 title이 없을 때 이름 후보)
 */
export async function analyzeReceived(zip, name) {
  return analyze(await fromZip(new Blob([zip]), { name }));
}

/**
 * analyzeReceived 결과를 설치한다 (source: 'qr').
 * @param {{senderName?: string | null, policy?: 'separate' | 'overwrite', expect?: object | null}} [options] META의 보낸 사람(정리한 값), 같은 이름 처리, 확인 화면의 계획
 */
export function installReceived(db, analysis, options) {
  return install(db, analysis, 'qr', options);
}
