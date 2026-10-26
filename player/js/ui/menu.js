// 앱 (⋯) 메뉴 (W-07)
//   방향키·Home/End로 이동, Esc·바깥 클릭·Tab으로 닫고 원래 버튼으로 포커스를 돌린다.

import { h } from './dialogs.js';

let open = null;

/**
 * @param {HTMLElement} anchor
 * @param {{label: string, icon?: string, value: string, danger?: boolean, disabled?: boolean, separator?: boolean}[]} items
 * @returns {Promise<string | null>} 고른 항목의 value, 닫으면 null
 */
export function openMenu(anchor, items) {
  open?.close(null);
  return new Promise((resolve) => {
    const menu = h('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (it.separator) menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      menu.append(h('button', {
        type: 'button',
        role: 'menuitem',
        class: `menu-item${it.danger ? ' danger' : ''}`,
        'data-value': it.value,
        disabled: it.disabled ?? false,
      }, [
        it.icon ? h('span', { class: 'menu-icon', 'aria-hidden': 'true', text: it.icon }) : '',
        it.label,
      ]));
    }
    document.body.append(menu);

    // anchor 아래(공간이 없으면 위)에, 오른쪽 끝을 맞춰 배치한다
    const r = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const top = r.bottom + 4 + m.height > innerHeight - 8 ? Math.max(8, r.top - 4 - m.height) : r.bottom + 4;
    const left = Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    anchor.setAttribute('aria-expanded', 'true');

    const enabled = () => [...menu.querySelectorAll('.menu-item:not(:disabled)')];
    const close = (value, refocus = true) => {
      if (open?.menu !== menu) return;
      open = null;
      menu.remove();
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      removeEventListener('resize', onResize);
      if (refocus && anchor.isConnected) anchor.focus();
      resolve(value);
    };
    const outside = (e) => {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) close(null, false);
    };
    const onResize = () => close(null, false);

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (item && !item.disabled) close(item.dataset.value);
    });
    menu.addEventListener('keydown', (e) => {
      const list = enabled();
      const i = list.indexOf(document.activeElement);
      const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
      if (move !== undefined) {
        e.preventDefault();
        list[(move + list.length) % list.length]?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'Tab') {
        close(null);
      }
    });
    document.addEventListener('pointerdown', outside, true);
    addEventListener('resize', onResize);

    open = { menu, close };
    enabled()[0]?.focus();
  });
}
