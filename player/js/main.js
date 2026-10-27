// 플레이어 진입점: DB 연결, 상태 저장소 초기화, 화면 연결

import { openDb, listApps, renameApp, clearAppStorage, deleteApp, NAME_MAX } from './db.js';
import { Store } from './store.js';
import { AppList } from './ui/list.js';
import { openMenu } from './ui/menu.js';
import { openAddSheet } from './ui/add-sheet.js';
import { confirmDialog, renameDialog, alertDialog, objectParticle, h } from './ui/dialogs.js';
import { registerServiceWorker, applyUpdate } from './update.js';
import { setupInstallPrompt, maybeShowIosGuide, requestPersistence } from './ui/install-prompt.js';
import { Viewer } from './ui/viewer.js';
import { openTransfer } from './ui/transfer-view.js';
import { ROLE } from './transfer/session.js';

const $ = (id) => document.getElementById(id);

let noticeTimer;
let updateShown = false;
/** 하단 안내. sticky가 아니면 4초 뒤 사라진다. action이 있으면 버튼을 붙이고 sticky로 둔다 */
function notice(message, { sticky = false, action = null } = {}) {
  const el = $('notice');
  el.replaceChildren(h('span', { text: message }));
  if (action) {
    const b = h('button', { type: 'button', class: 'notice-action', text: action.label });
    b.addEventListener('click', action.onClick);
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(noticeTimer);
  if (!sticky && !action) {
    noticeTimer = setTimeout(() => {
      el.hidden = true;
      // 잠깐 덮인 새 버전 토스트는 다시 띄운다
      if (updateShown) showUpdateNotice();
    }, 4000);
  }
}

const store = new Store();
// beforeinstallprompt는 일찍 올 수 있으므로 DB를 열기 전에 듣는다
const installPrompt = setupInstallPrompt({ banner: $('install-banner') });

/** 새 버전 토스트 (SPEC F-01 6). 앱 실행·전송 중에는 홈으로 돌아올 때까지 미룬다 */
let updatePending = false;
function showUpdateNotice() {
  updatePending = true;
  if (store.state.screen !== 'home' || document.querySelector('.transfer')) return;
  updatePending = false;
  updateShown = true;
  notice('새 버전이 있습니다', { action: { label: '새로고침', onClick: applyUpdate } });
}
let db = null;

const list = new AppList($('app-list'), {
  onSelect: (id) => store.select(id),
  onMenu: (id, anchor) => showMenu(id, anchor),
});

const viewer = new Viewer($('viewer'), { store, onDelete: (id) => confirmDelete(id) });

/** 삭제 확인 (W-12) → 단일 트랜잭션 삭제. 삭제했으면 true */
async function confirmDelete(id) {
  const app = store.state.apps.find((a) => a.id === id);
  if (!app || viewer.running) return false;
  const ok = await confirmDialog({
    title: `‘${app.name}’${objectParticle(app.name)} 삭제할까요?`,
    message: '앱과 저장 데이터가 삭제됩니다. 되돌릴 수 없습니다.',
    confirmLabel: '삭제',
    danger: true,
  });
  if (!ok) return false;
  await deleteApp(db, id);
  viewer.clearError(id);
  store.removeApp(id);
  return true;
}

function render(state, keys = ['apps', 'selectedId', 'screen']) {
  if (keys.includes('apps') || keys.includes('selectedId')) {
    list.render(state.apps, state.selectedId);
    $('empty').hidden = state.apps.length > 0;
    viewer.render(store.selectedApp);
  }
  $('shell').dataset.screen = state.screen;
  if (updatePending && state.screen === 'home') showUpdateNotice();
}

async function showMenu(id, anchor) {
  const app = store.state.apps.find((a) => a.id === id);
  // 실행 중에는 목록이 숨겨지지만, 만일을 위해 삭제·초기화를 막는다 (F-03 5)
  if (!app || viewer.running) return;
  const choice = await openMenu(anchor, [
    { icon: '✏️', label: '이름 바꾸기', value: 'rename' },
    { icon: '📤', label: '전송하기', value: 'send' },
    { icon: '🔄', label: '초기화', value: 'reset' },
    { icon: '🗑️', label: '삭제', value: 'delete', danger: true, separator: true },
  ]);
  try {
    if (choice === 'rename') {
      const name = await renameDialog({ current: app.name, max: NAME_MAX });
      if (name !== null && name !== app.name) {
        const updated = await renameApp(db, id, name);
        if (updated) store.upsertApp(updated);
      }
    } else if (choice === 'reset') {
      const ok = await confirmDialog({
        title: `‘${app.name}’${objectParticle(app.name)} 초기화할까요?`,
        message: '저장된 점수와 설정이 모두 지워집니다. 앱은 그대로 남아 있습니다.',
        confirmLabel: '초기화',
        danger: true,
      });
      if (ok) {
        await clearAppStorage(db, id);
        notice('저장 데이터를 지웠습니다.');
      }
    } else if (choice === 'delete') {
      if (await confirmDelete(id)) return;
    } else if (choice === 'send') {
      await openTransfer({ db, role: ROLE.SENDER, appId: id });
      if (updatePending) showUpdateNotice();
    }
  } catch (err) {
    console.error(err);
    await alertDialog({ title: '작업을 끝내지 못했습니다', message: '잠시 후 다시 시도해 주세요.' });
  }
  if (choice) list.focusMenuButton(id);
}

/** [QR로 받기] (SPEC F-05): 받은 앱은 새 ID로 설치되고 선택된다 */
function receiveByQr() {
  openTransfer({
    db,
    role: ROLE.RECEIVER,
    onInstalled: (app) => {
      store.upsertApp(app);
      store.select(app.id);
      list.reveal(app.id);
    },
    onLaunch: (id) => {
      store.select(id);
      viewer.play(id);
    },
  }).then(() => { if (updatePending) showUpdateNotice(); });
}

async function start() {
  store.subscribe(render);
  render(store.state);
  registerServiceWorker({ onWaiting: showUpdateNotice });

  try {
    db = await openDb({
      onBlocked: () => notice('다른 창의 Toybox를 닫아 주세요.', { sticky: true }),
      onVersionChange: () => notice('Toybox가 업데이트되었습니다. 새로고침해 주세요.', { sticky: true }),
    });
  } catch (err) {
    notice('저장소를 열 수 없습니다. 비공개 모드에서는 Toybox를 사용할 수 없을 수 있어요.', { sticky: true });
    console.error(err);
    return;
  }
  list.setDb(db);
  viewer.setDb(db);
  store.setApps(await listApps(db));
  requestPersistence(db);
  // 설치하면 Chrome이 저장소 유지를 허용하므로 한 번 더 요청한다
  installPrompt.onInstalled(() => requestPersistence(db, { force: true }));
  maybeShowIosGuide();
  if (store.state.selectedId) list.reveal(store.state.selectedId);

  $('add-button').addEventListener('click', async () => {
    const app = await openAddSheet(db, { onQr: receiveByQr });
    if (!app) return;
    store.upsertApp(app);
    store.select(app.id);
    list.reveal(app.id);
  });
}

start();

export { store };
