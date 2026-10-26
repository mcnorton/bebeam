// 공통 모달 (W-10~W-13)
//   네이티브 <dialog>.showModal()을 쓴다: 바깥은 inert가 되어 포커스가 갇히고, Esc는 cancel 이벤트가 된다.
//   앱이 제공한 문자열(이름 등)은 항상 textContent로만 넣는다 (ARCHITECTURE §4.4, T7).

/** 이름 뒤 목적격 조사: 받침이 있으면 '을', 없으면 '를', 한글로 끝나지 않으면 '을(를)' */
export function objectParticle(name) {
  const s = String(name).trimEnd();
  const code = s.codePointAt(s.length - 1) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return '을(를)';
  return (code - 0xac00) % 28 ? '을' : '를';
}

/** @param {string} tag @param {Record<string, string>} [attrs] @param {(Node | string)[]} [children] */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children);
  return el;
}

/**
 * 모달을 열고, 닫힐 때 returnValue로 resolve한다. Esc와 배경 클릭은 '', value 'cancel' 버튼은 'cancel'이다.
 * @param {{title: string, body?: Node[], buttons: {label: string, value: string, kind?: 'primary' | 'danger', autofocus?: boolean}[], className?: string, onOpen?: (dlg: HTMLDialogElement) => void, validate?: (value: string, dlg: HTMLDialogElement) => boolean}} spec
 * @returns {Promise<{value: string, dialog: HTMLDialogElement}>}
 */
export function openDialog({ title, body = [], buttons, className = '', onOpen, validate }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const form = h('form', { method: 'dialog', class: 'dialog-form' }, [
    h('h2', { id: titleId, class: 'dialog-title', text: title }),
    ...body,
    h('div', { class: 'dialog-actions' }, buttons.map((b) =>
      h('button', {
        // 취소 버튼은 submit이 아니다: 입력창에서 Enter를 누르면 첫 submit 버튼이 눌리므로
        type: b.value === 'cancel' ? 'button' : 'submit',
        value: b.value,
        class: `btn ${b.kind ? `btn-${b.kind}` : ''}`,
        autofocus: b.autofocus ?? false,
        text: b.label,
      }))),
  ]);
  const dlg = h('dialog', { class: `dialog ${className}`, 'aria-labelledby': titleId }, [form]);
  form.querySelector('button[type=button][value=cancel]')?.addEventListener('click', () => dlg.close('cancel'));

  form.addEventListener('submit', (e) => {
    const value = e.submitter?.value ?? '';
    if (validate && value && !validate(value, dlg)) e.preventDefault();
  });
  // 배경(::backdrop) 클릭은 취소
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close('');
  });

  document.body.append(dlg);
  return new Promise((resolve) => {
    // Chrome 154에서 Esc로 닫으면 cancel 뒤에 close 이벤트가 오지 않는 경우가 있다.
    // 그래서 open 속성이 사라지는 것도 함께 지켜보고, 먼저 오는 쪽에서 한 번만 끝낸다.
    let finished = false;
    const finish = () => {
      if (finished || dlg.open) return;
      finished = true;
      watch.disconnect();
      dlg.remove();
      resolve({ value: dlg.returnValue, dialog: dlg });
    };
    const watch = new MutationObserver(finish);
    dlg.addEventListener('close', finish);
    dlg.showModal();
    watch.observe(dlg, { attributes: true, attributeFilter: ['open'] });
    onOpen?.(dlg);
  });
}

/**
 * 확인 대화창 (W-10, W-12, W-13). 기본 포커스는 취소 쪽이다.
 * @returns {Promise<boolean>}
 */
export async function confirmDialog({ title, message = '', confirmLabel = '확인', cancelLabel = '취소', danger = false }) {
  const { value } = await openDialog({
    title,
    body: message ? [h('p', { class: 'dialog-message', text: message })] : [],
    buttons: [
      { label: cancelLabel, value: 'cancel', autofocus: true },
      { label: confirmLabel, value: 'ok', kind: danger ? 'danger' : 'primary' },
    ],
  });
  return value === 'ok';
}

/** 안내 대화창 (오류 표시 등) */
export async function alertDialog({ title, message = '', label = '닫기' }) {
  await openDialog({
    title,
    body: message ? [h('p', { class: 'dialog-message', text: message })] : [],
    buttons: [{ label, value: 'ok', kind: 'primary', autofocus: true }],
  });
}

/**
 * 이름 바꾸기 (W-11): 1–max자, 앞뒤 공백 제거, 글자 수 표시.
 * @returns {Promise<string | null>} 취소하면 null
 */
export async function renameDialog({ current, max = 60 }) {
  const count = (s) => [...s.trim()].length;
  const input = h('input', {
    type: 'text', class: 'text-input', name: 'name', 'aria-label': '앱 이름', autocomplete: 'off', enterkeyhint: 'done',
  });
  input.value = current;
  const counter = h('p', { class: 'counter', 'aria-live': 'polite' });
  const update = () => {
    const n = count(input.value);
    counter.textContent = `${n} / ${max}`;
    counter.classList.toggle('over', n === 0 || n > max);
  };
  input.addEventListener('input', update);
  update();

  const { value } = await openDialog({
    title: '이름 바꾸기',
    body: [input, counter],
    buttons: [
      { label: '취소', value: 'cancel' },
      { label: '저장', value: 'ok', kind: 'primary' },
    ],
    onOpen: () => {
      input.focus();
      input.select();
    },
    validate: (v) => {
      if (v !== 'ok') return true;
      const n = count(input.value);
      if (n >= 1 && n <= max) return true;
      input.focus();
      return false;
    },
  });
  return value === 'ok' ? input.value.trim() : null;
}
