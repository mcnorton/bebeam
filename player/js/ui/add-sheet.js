// 앱 추가 시트와 설치 확인 (F-02, W-05, W-06)
//   [QR로 받기] (M3) · [폴더 추가] · [zip 파일 추가] → 분석(진행 표시) → 설치 확인 → 설치

import { fromFolder, fromZip } from '../installer/source.js';
import { analyze, install, checkSpace, formatBytes } from '../installer/install.js';
import { h, openDialog, alertDialog } from './dialogs.js';
import { iconUrl } from './list.js';
import { icon as lineIcon } from './icons.js';
import { listApps } from '../db.js';
import { getDuplicatePolicy } from '../settings.js';
import { planDuplicate } from '../installer/duplicates.js';

const STEP_LABEL = {
  read: '파일을 읽는 중…',
  validate: '파일을 확인하는 중…',
  meta: '앱 정보를 읽는 중…',
  plan: '파일 사이의 연결을 분석하는 중…',
  hash: '파일 지문을 계산하는 중…',
  install: '설치하는 중…',
};

/** iOS는 webkitdirectory 속성이 있어도 폴더 선택을 지원하지 않는다 (ARCHITECTURE §8) */
export function supportsFolderPick() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return !ios && 'webkitdirectory' in document.createElement('input');
}

function fileInput({ folder }) {
  const input = h('input', { type: 'file', hidden: true });
  if (folder) input.webkitdirectory = true;
  else input.accept = '.zip,application/zip,application/x-zip-compressed';
  document.body.append(input);
  return input;
}

/** 파일 선택 창을 연다. 사용자 제스처 안에서 동기적으로 호출해야 한다 */
function pick(input) {
  return new Promise((resolve) => {
    input.addEventListener('change', () => resolve(input.files), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** 닫을 수 없는 진행 표시 */
function progressDialog() {
  const text = h('p', { class: 'dialog-message', 'aria-live': 'polite' });
  const bar = h('progress', { class: 'progress' });
  const dlg = h('dialog', { class: 'dialog progress-dialog', 'aria-label': '앱 분석' }, [
    h('div', { class: 'dialog-form' }, [h('h2', { class: 'dialog-title', text: '나의 앱 추가' }), text, bar]),
  ]);
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
  return {
    step(key, index, total) {
      text.textContent = STEP_LABEL[key] ?? '';
      if (total) {
        bar.max = total;
        bar.value = index + 1;
      } else {
        bar.removeAttribute('value');
      }
    },
    close() {
      dlg.close();
      dlg.remove();
    },
  };
}

/** 경고 상자: 왼쪽 선 아이콘 + 문단들 */
function warning(paragraphs) {
  return h('div', { class: 'warning', role: 'note' }, [lineIcon('triangle-alert', { class: 'warning-icon' }), h('div', {}, paragraphs)]);
}

/** 같은 이름의 앱이 있을 때 설치 결과 한 줄 (설정에 따라) */
export function duplicateNote(plan) {
  if (plan.kind === 'overwrite') return `같은 이름의 ‘${plan.name}’ 앱을 덮어씁니다. 점수·설정은 남습니다.`;
  if (plan.kind === 'separate') return `같은 이름의 앱이 있어 ‘${plan.name}’(으)로 따로 추가합니다.`;
  return '';
}

/** W-06 본문 */
function summaryBody(a, space, iconUrl, plan) {
  const rows = [
    h('div', { class: 'install-head' }, [
      h('img', { class: 'app-icon large', alt: '', src: iconUrl ?? DEFAULT_ICON_URL, width: '56', height: '56' }),
      h('div', { class: 'app-text' }, [
        h('p', { class: 'install-name', text: a.name }),
        a.description ? h('p', { class: 'install-desc', text: a.description }) : '',
      ]),
    ]),
    h('p', { class: 'install-stat', text: `파일 ${a.fileCount}개 · ${formatBytes(a.size)}` }),
  ];
  if (plan && plan.kind !== 'new') {
    rows.push(h('p', { class: 'install-stat duplicate-note', text: duplicateNote(plan) }));
  }
  if (a.excludedCount) {
    rows.push(h('p', { class: 'install-stat muted', text: `제외된 파일 ${a.excludedCount}개 (지원하지 않는 형식)` }));
  }
  if (a.externalRefs.length) {
    rows.push(warning([
      h('p', { text: `이 앱은 인터넷의 파일을 사용합니다 (${a.externalRefs.slice(0, 3).join(', ')}${a.externalRefs.length > 3 ? ' 외' : ''}).` }),
      h('p', { text: 'BeBeam에서는 외부 통신이 차단되어 일부 기능이 동작하지 않을 수 있습니다.' }),
    ]));
  }
  if (a.rewritePlan.warnings.some((w) => w.startsWith('cyclic-import:'))) {
    rows.push(warning([
      h('p', { text: '서로를 불러오는 모듈(순환 import)이 있어 실행되지 않을 수 있습니다.' }),
    ]));
  }
  if (space && !space.enough) {
    rows.push(warning([
      h('p', { text: `저장 공간이 부족할 수 있습니다 (사용 중 ${formatBytes(space.usage)} / 가능 ${formatBytes(space.quota)}).` }),
    ]));
  }
  return rows;
}

const DEFAULT_ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#8a8fa3"/></svg>',
)}`;

/**
 * 고른 파일을 분석하고, 확인을 받아 설치한다.
 * @returns {Promise<object | null>} 설치한 apps 레코드
 */
async function analyzeAndInstall(db, readSource, sourceKind) {
  const progress = progressDialog();
  let analysis;
  try {
    progress.step('read');
    const source = await readSource();
    analysis = await analyze(source, { onStep: (s, i, n) => progress.step(s, i, n) });
  } catch (err) {
    progress.close();
    await showError(err);
    return null;
  }
  progress.close();

  const space = await checkSpace(analysis.size);
  const policy = await getDuplicatePolicy(db);
  const plan = planDuplicate(await listApps(db), analysis.name, policy);
  const icon = analysis.iconPath && analysis.files.find((f) => f.path === analysis.iconPath);
  const iconRef = icon ? await iconUrl(icon.blob, icon.mime).catch(() => null) : null;
  let ok;
  try {
    ({ value: ok } = await openDialog({
      title: '앱 설치',
      className: 'install-dialog',
      body: summaryBody(analysis, space, iconRef?.url, plan),
      buttons: [
        { label: '취소', value: 'cancel' },
        { label: plan.kind === 'overwrite' ? '덮어쓰기' : '설치', value: 'ok', kind: 'primary', autofocus: true },
      ],
    }));
  } finally {
    iconRef?.revoke();
  }
  if (ok !== 'ok') return null;

  const p2 = progressDialog();
  p2.step('install');
  try {
    return await install(db, analysis, sourceKind, { policy, expect: plan });
  } catch (err) {
    p2.close();
    await showError(err);
    return null;
  } finally {
    p2.close(); // 두 번 불러도 괜찮다
  }
}

async function showError(err) {
  console.error(err);
  const known = err?.name === 'InstallError';
  await alertDialog({
    title: '설치할 수 없습니다',
    message: known ? err.message : '파일을 처리하는 중 문제가 생겼습니다.',
  });
}

function option({ value, icon: iconName, title, desc, disabled = false }) {
  return h('button', { type: 'button', class: 'sheet-option', 'data-value': value, disabled }, [
    lineIcon(iconName, { class: 'sheet-icon' }),
    h('span', { class: 'sheet-text' }, [
      h('span', { class: 'sheet-title', text: title }),
      h('span', { class: 'sheet-desc', text: desc }),
    ]),
  ]);
}

/**
 * 앱 추가 시트 (W-05). 설치에 성공하면 apps 레코드를 돌려준다.
 * [QR로 받기]를 고르면 onQr를 부르고 null을 돌려준다 (전송 화면이 따로 설치한다).
 * @param {IDBDatabase} db
 * @param {{onQr?: () => void}} [options]
 * @returns {Promise<object | null>}
 */
export async function openAddSheet(db, { onQr } = {}) {
  const options = [
    option({ value: 'qr', icon: 'scan-qr-code', title: 'QR로 받기', desc: '친구 화면의 QR을 카메라로 받기', disabled: !onQr }),
    supportsFolderPick() ? option({ value: 'folder', icon: 'folder', title: '폴더 추가', desc: 'index.html이 있는 폴더' }) : '',
    option({ value: 'zip', icon: 'file-archive', title: 'zip 파일 추가', desc: '폴더를 압축한 파일' }),
  ];
  let picked = null;
  await openDialog({
    title: '나의 앱 추가',
    className: 'sheet',
    body: [h('div', { class: 'sheet-options' }, options)],
    buttons: [{ label: '닫기', value: 'cancel' }],
    onOpen: (dlg) => {
      dlg.querySelector('.sheet-options').addEventListener('click', (e) => {
        const btn = e.target.closest('.sheet-option');
        if (!btn || btn.disabled) return;
        if (btn.dataset.value === 'qr') {
          picked = { qr: true };
          dlg.close('picked');
          return;
        }
        // 파일 선택 창은 사용자 제스처 안에서 바로 열어야 한다 (Safari)
        const folder = btn.dataset.value === 'folder';
        const input = fileInput({ folder });
        picked = { folder, files: pick(input).finally(() => input.remove()) };
        dlg.close('picked');
      });
      dlg.querySelector('.sheet-option:not(:disabled)')?.focus();
    },
  });
  if (!picked) return null;
  if (picked.qr) {
    onQr?.();
    return null;
  }

  const files = await picked.files;
  if (!files?.length) return null;
  if (picked.folder) {
    return analyzeAndInstall(db, async () => fromFolder(files), 'folder');
  }
  return analyzeAndInstall(db, () => fromZip(files[0]), 'zip');
}
