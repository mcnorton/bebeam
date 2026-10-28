// 다크/라이트 전환 (타이틀바 버튼). 선택은 이 기기에만 저장한다 (js/theme-init.js가 다음 실행 때 먼저 적용)

import { icon } from './icons.js';

const KEY = 'bebeam.ui.theme';
const THEME_COLOR = { light: '#ffffff', dark: '#09090b' };

/** 지금 보이는 테마: data-theme이 없으면 시스템 설정 */
export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  // media가 붙은 theme-color 둘을 모두 지금 테마 색으로 맞춘다
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = THEME_COLOR[theme];
}

/** @param {HTMLButtonElement} button */
export function setupThemeButton(button) {
  const paint = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    button.replaceChildren(icon(next === 'dark' ? 'moon' : 'sun'));
    button.setAttribute('aria-label', next === 'dark' ? '다크 모드로' : '라이트 모드로');
    button.title = button.getAttribute('aria-label');
  };
  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch { /* 이번 실행에만 적용된다 */ }
    paint();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
  if (document.documentElement.dataset.theme) apply(currentTheme());
  paint();
}
