// 앱 목록 (F-03, W-04)
//   항목: [아이콘 40px] 이름 / 설명(작게 2줄) / 보낸 사람(오른쪽, QR로 받은 앱만)  [⋯]
//   앱 문자열은 textContent로만 렌더링한다. 아이콘은 iconUrl()로 만든 URL을 <img>에 넣는다
//   (<img> 문맥의 SVG는 스크립트를 실행하지 않는다, ARCHITECTURE §6 T8).

import { request } from '../db.js';
import { h } from './dialogs.js';
import { icon as lineIcon } from './icons.js';

const SVG_ICON_MAX = 256 * 1024;

/**
 * 아이콘 표시용 URL. 저장된 MIME으로 다시 감싼다 (Blob의 type은 신뢰하지 않음, C-2).
 * SVG는 data: URL로 만든다: 플레이어 origin의 blob: URL은 "새 탭에서 이미지 열기"로
 * 최상위 문서가 되면 SVG 안의 스크립트가 플레이어 origin에서 돌 수 있기 때문이다 (T8).
 * data: 문서는 opaque origin이고 주요 브라우저는 최상위 data: 이동도 막는다.
 * @returns {Promise<{url: string, revoke: () => void} | null>}
 */
export async function iconUrl(blob, mime) {
  if (mime === 'image/svg+xml') {
    if (blob.size > SVG_ICON_MAX) return null;
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(new Blob([blob], { type: mime }));
    });
    return { url, revoke: () => {} };
  }
  const url = URL.createObjectURL(new Blob([blob], { type: mime }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

export class AppList {
  #ul;
  #db = null;
  /** appId → {iconPath, updatedAt, url: string | null, pending: Promise} */
  #icons = new Map();
  #onSelect;
  #onMenu;

  /**
   * @param {HTMLUListElement} ul
   * @param {{onSelect: (id: string) => void, onMenu: (id: string, anchor: HTMLElement) => void}} handlers
   */
  constructor(ul, { onSelect, onMenu }) {
    this.#ul = ul;
    this.#onSelect = onSelect;
    this.#onMenu = onMenu;
    ul.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      if (e.target.closest('.app-menu-button')) this.#onMenu(li.dataset.id, e.target.closest('button'));
      else if (e.target.closest('.app-item')) this.#onSelect(li.dataset.id);
    });
  }

  setDb(db) {
    this.#db = db;
  }

  /** @param {readonly object[]} apps @param {string | null} selectedId */
  render(apps, selectedId) {
    const live = new Set(apps.map((a) => a.id));
    for (const id of this.#icons.keys()) if (!live.has(id)) this.#dropIcon(id);

    const items = apps.map((app) => {
      const selected = app.id === selectedId;
      const icon = h('img', { class: 'app-icon', alt: '', width: '40', height: '40', draggable: 'false' });
      this.#bindIcon(app, icon);
      return h('li', { 'data-id': app.id, class: selected ? 'selected' : '' }, [
        h('button', { type: 'button', class: 'app-item', 'aria-current': selected ? 'true' : false }, [
          icon,
          h('span', { class: 'app-text' }, [
            h('span', { class: 'app-name', text: app.name }),
            h('span', { class: `app-desc${app.description ? '' : ' none'}`, text: app.description || '(설명 없음)' }),
            app.senderName ? h('span', { class: 'app-sender', text: app.senderName }) : '',
          ]),
        ]),
        h('button', {
          type: 'button', class: 'app-menu-button', 'aria-haspopup': 'menu', 'aria-label': `${app.name} 메뉴`,
        }, [lineIcon('ellipsis')]),
      ]);
    });
    this.#ul.replaceChildren(...items);
  }

  /** 선택 항목이 보이게 스크롤 */
  reveal(id) {
    this.#ul.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  focusMenuButton(id) {
    this.#ul.querySelector(`li[data-id="${CSS.escape(id)}"] .app-menu-button`)?.focus();
  }

  #bindIcon(app, img) {
    img.src = DEFAULT_ICON;
    if (!app.iconPath || !this.#db) return;
    let entry = this.#icons.get(app.id);
    // 덮어쓰기로 파일이 바뀌면 경로가 같아도 updatedAt이 달라진다
    if (entry && (entry.iconPath !== app.iconPath || entry.updatedAt !== app.updatedAt)) {
      this.#dropIcon(app.id);
      entry = undefined;
    }
    if (!entry) {
      entry = { iconPath: app.iconPath, updatedAt: app.updatedAt, url: null };
      entry.pending = request(this.#db.transaction('files').objectStore('files').get([app.id, app.iconPath]))
        .then((file) => (file?.blob ? iconUrl(file.blob, file.mime) : null))
        .then((icon) => {
          if (!icon) return;
          if (this.#icons.get(app.id) === entry) {
            entry.url = icon.url;
            entry.revoke = icon.revoke;
          } else {
            icon.revoke();
          }
        })
        .catch(() => {});
      this.#icons.set(app.id, entry);
    }
    entry.pending.then(() => {
      if (entry.url) img.src = entry.url;
    });
    img.addEventListener('error', () => { img.src = DEFAULT_ICON; }, { once: true });
  }

  #dropIcon(id) {
    const entry = this.#icons.get(id);
    entry?.revoke?.();
    this.#icons.delete(id);
  }
}

/** 기본 아이콘: 둥근 사각형 안의 블록 */
const DEFAULT_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#8a8fa3"/>'
  + '<rect x="11" y="11" width="8" height="8" rx="2" fill="#fff"/><rect x="21" y="11" width="8" height="8" rx="2" fill="#fff" opacity=".7"/>'
  + '<rect x="11" y="21" width="8" height="8" rx="2" fill="#fff" opacity=".7"/><rect x="21" y="21" width="8" height="8" rx="2" fill="#fff"/></svg>',
)}`;
