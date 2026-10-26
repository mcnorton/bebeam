// 플레이어 상태 저장소 (EventTarget 기반)
//   apps: 최근 추가 순 앱 목록 (db.listApps 결과)
//   selectedId: 선택한 앱. localStorage toybox.ui.selectedAppId에 기억한다 (DATABASE §3)
//   screen: 'home' | 'running' | 'transfer'
// 상태가 바뀌면 'change' 이벤트(detail.keys: 바뀐 키 목록)를 보낸다.

export const SELECTED_KEY = 'toybox.ui.selectedAppId';
export const SCREENS = Object.freeze(['home', 'running', 'transfer']);

/** localStorage는 막혀 있을 수 있다 (사파리 비공개 모드 등). 실패는 무시한다 */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {}
}

export class Store extends EventTarget {
  #storage;
  #state;

  /** @param {{storage?: Storage | null}} [options] */
  constructor({ storage = safeStorage() } = {}) {
    super();
    this.#storage = storage;
    this.#state = Object.freeze({
      apps: Object.freeze([]),
      selectedId: read(storage, SELECTED_KEY),
      screen: 'home',
    });
  }

  get state() {
    return this.#state;
  }

  get selectedApp() {
    const { apps, selectedId } = this.#state;
    return apps.find((a) => a.id === selectedId) ?? null;
  }

  #set(patch) {
    const keys = Object.keys(patch).filter((k) => patch[k] !== this.#state[k]);
    if (!keys.length) return;
    this.#state = Object.freeze({ ...this.#state, ...patch });
    if (keys.includes('selectedId')) write(this.#storage, SELECTED_KEY, this.#state.selectedId);
    this.dispatchEvent(new CustomEvent('change', { detail: { keys } }));
  }

  /** 목록 전체 교체. 선택한 앱이 목록에 없으면 선택을 푼다 */
  setApps(apps) {
    const list = Object.freeze([...apps]);
    const { selectedId } = this.#state;
    const keep = selectedId !== null && list.some((a) => a.id === selectedId);
    this.#set({ apps: list, selectedId: keep ? selectedId : null });
  }

  /** 새 앱은 맨 앞에, 기존 앱은 제자리에서 교체 */
  upsertApp(app) {
    const { apps } = this.#state;
    const i = apps.findIndex((a) => a.id === app.id);
    const list = i < 0 ? [app, ...apps] : apps.with(i, app);
    this.#set({ apps: Object.freeze(list) });
  }

  removeApp(id) {
    const { apps, selectedId } = this.#state;
    this.#set({
      apps: Object.freeze(apps.filter((a) => a.id !== id)),
      selectedId: selectedId === id ? null : selectedId,
    });
  }

  /** @param {string | null} id 목록에 없는 ID는 선택 해제로 처리한다 */
  select(id) {
    const ok = id !== null && this.#state.apps.some((a) => a.id === id);
    this.#set({ selectedId: ok ? id : null });
  }

  setScreen(screen) {
    if (!SCREENS.includes(screen)) throw new RangeError(`unknown screen: ${screen}`);
    this.#set({ screen });
  }

  /** @param {(state: object, keys: string[]) => void} fn @returns {() => void} 구독 해제 */
  subscribe(fn) {
    const h = (e) => fn(this.#state, e.detail.keys);
    this.addEventListener('change', h);
    return () => this.removeEventListener('change', h);
  }
}
