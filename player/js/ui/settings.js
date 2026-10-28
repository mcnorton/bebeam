// 설정 화면 (W-16): 내 이름, 같은 이름의 앱을 추가할 때

import { h, openDialog } from './dialogs.js';
import { icon } from './icons.js';
import { indianName, USER_NAME_MAX } from '../names.js';
import { getUserName, getDuplicatePolicy, saveSettings, DUPLICATE } from '../settings.js';

function radio(name, value, label, desc, checked) {
  const input = h('input', { type: 'radio', name, value, checked });
  return h('label', { class: 'radio-option' }, [
    input,
    h('span', { class: 'radio-text' }, [h('span', { text: label }), h('span', { class: 'radio-desc', text: desc })]),
  ]);
}

/** @returns {Promise<boolean>} 저장했으면 true */
export async function openSettings(db) {
  const [userName, policy] = await Promise.all([getUserName(db), getDuplicatePolicy(db)]);

  const input = h('input', {
    type: 'text', id: 'settings-name', class: 'text-input', maxlength: String(USER_NAME_MAX), autocomplete: 'off', enterkeyhint: 'done',
    placeholder: '비워 두면 새로 지어 드려요',
  });
  input.value = userName;
  const reroll = h('button', { type: 'button', class: 'btn btn-square', 'aria-label': '이름 다시 뽑기', title: '이름 다시 뽑기' }, [icon('shuffle')]);
  reroll.addEventListener('click', () => {
    input.value = indianName();
    input.focus();
  });

  const body = [
    h('div', { class: 'field' }, [
      h('label', { class: 'field-label', for: 'settings-name', text: '내 이름은' }),
      h('div', { class: 'field-row' }, [input, reroll]),
      h('p', { class: 'field-desc', text: '앱을 보낼 때 받는 사람 목록에 이 이름이 보여요.' }),
    ]),
    h('fieldset', { class: 'field' }, [
      h('legend', { class: 'field-label', text: '같은 이름의 앱을 추가할 때' }),
      radio('dup', DUPLICATE.SEPARATE, '따로 추가', '이름 뒤에 (1), (2)… 순서를 붙여요', policy === DUPLICATE.SEPARATE),
      radio('dup', DUPLICATE.OVERWRITE, '덮어쓰기', '가장 최근 앱을 새것으로 바꿔요. 점수·설정은 남아요', policy === DUPLICATE.OVERWRITE),
    ]),
  ];

  let picked = policy;
  const { value } = await openDialog({
    title: '설정',
    className: 'settings-dialog',
    body,
    buttons: [
      { label: '취소', value: 'cancel' },
      { label: '저장', value: 'ok', kind: 'primary' },
    ],
    onOpen: (dlg) => {
      dlg.addEventListener('change', (e) => {
        if (e.target.name === 'dup') picked = e.target.value;
      });
    },
  });
  if (value !== 'ok') return false;
  await saveSettings(db, { userName: input.value, duplicatePolicy: picked });
  return true;
}
