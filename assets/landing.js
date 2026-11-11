// 랜딩 (SPEC F-01 2, W-01): [BeBeam 실행](iOS·macOS Safari는 [BeBeam 설치하기])은 새 창에서 연다. 팝업이 막히면 같은 창으로 이동한다.
//   noopener를 넘기면 window.open이 항상 null을 돌려줘 차단 여부를 알 수 없으므로, 연 뒤에 opener를 끊는다.

// 실행 버튼은 머리(쇼 아래)와 순서도 Ⅱ에 하나씩 있다. 둘 다 같은 동작이다.
// iOS(홈 화면)·macOS Safari(Dock)는 설치해야 플레이어를 쓸 수 있다(탭에서는 설치 안내만 보인다). 그래서 버튼 이름을 바꾼다.
// 판정은 player/js/ui/install-prompt.js isIos·isMacSafari와 같은 규칙 (iPadOS는 Mac처럼 보이므로 터치 지점 수로)
const ua = navigator.userAgent;
const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const macSafari = !ios && /Macintosh/.test(ua) && /Version\/[\d.]+.* Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
for (const link of document.querySelectorAll('a.launch')) {
  if (ios || macSafari) link.lastChild.textContent = ' BeBeam 설치하기';
  link.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 브라우저 기본 동작(새 탭 등)
    e.preventDefault();
    const w = window.open(link.href, '_blank');
    if (w) w.opener = null;
    else location.href = link.href;
  });
}

// AI용 바이브 코딩 프롬프트·규칙 주소 [복사] (TASK T6.1). 버튼의 data-copy가 복사할 칸이다.
//   복사를 못 하면 칸을 선택해 두어 직접 복사하게 한다
//   안내는 버튼이 속한 칸(.ai)의 상태 줄에 쓴다
const PROMPT_COPIED = '프롬프트를 복사했어요. AI 대화창에 붙여 넣으세요';
const COPIED = { 'ai-prompt': PROMPT_COPIED, 'ai-convert-prompt': PROMPT_COPIED, 'ai-url': '주소를 복사했어요' };
const statusTimers = new Map(); // 상태 줄마다 지우기 타이머 하나 (같은 칸의 두 버튼이 서로 일찍 지우지 않게)
for (const button of document.querySelectorAll('[data-copy]')) {
  const field = document.getElementById(button.dataset.copy);
  const aiStatus = button.closest('.ai').querySelector('.ai-status');
  field.addEventListener('focus', () => field.select());
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      aiStatus.textContent = COPIED[field.id];
    } catch {
      field.focus();
      field.select();
      aiStatus.textContent = '선택해 두었어요. 직접 복사해 주세요';
    }
    clearTimeout(statusTimers.get(aiStatus));
    statusTimers.set(aiStatus, setTimeout(() => { aiStatus.textContent = ''; }, 2500));
  });
}

// Ⅰ 재료 손질 갈림길 (docs/SITES.md): 고른 길(A/B/C)만 펼치고 비비의 말을 바꾼다. 고른 길은 기억한다.
//   HTML은 세 길이 모두 열린 채로 오므로, JS가 없으면 다 보인다. 글은 HTML의 data-line(고정 문자열)만 쓴다
const KEY_PATH = 'bebeam-landing:path';
const choices = [...document.querySelectorAll('.choice')];
const chefLine = document.getElementById('chef-line');
const firstLine = chefLine.textContent;
function choose(button, { scroll = false } = {}) {
  for (const b of choices) {
    const on = b === button;
    b.setAttribute('aria-expanded', String(on));
    document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
  }
  chefLine.textContent = button ? button.dataset.line : firstLine;
  if (!button) return;
  try { localStorage.setItem(KEY_PATH, button.dataset.path); } catch {}
  if (scroll) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(button.getAttribute('aria-controls')).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  }
}
let savedPath = null;
try { savedPath = localStorage.getItem(KEY_PATH); } catch {}
choose(choices.find((b) => b.dataset.path === savedPath) ?? null);
for (const b of choices) b.addEventListener('click', () => choose(b, { scroll: true }));

// 비빔재료 (SPEC F-01 1): samples.json의 샘플 앱 목록과 [내려받기].
//   나중에 백엔드가 같은 모양을 돌려줄 수 있으므로 값은 글자로만 넣고, 경로는 assets/samples/ 안의 것만 쓴다
const SAMPLE_PREFIX = 'assets/samples/';
// 글자로 거르고(%·공백·제어문자로 ..을 숨기지 못하게), URL로 풀어 같은 origin의 /assets/samples/ 안인지 한 번 더 본다
function samplePath(p) {
  if (typeof p !== 'string' || !p.startsWith(SAMPLE_PREFIX) || p.includes('..') || /[?#\\:%\s\u0000-\u001f]/.test(p)) return false;
  const url = new URL(p, location.href);
  return url.origin === location.origin && url.pathname.startsWith(new URL(SAMPLE_PREFIX, location.href).pathname);
}
const sampleSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

async function showSamples() {
  const section = document.getElementById('samples');
  const list = document.getElementById('sample-list');
  const tpl = document.getElementById('sample-item');
  try {
    const res = await fetch(`${SAMPLE_PREFIX}samples.json`);
    if (!res.ok) return;
    const { items } = await res.json();
    for (const it of Array.isArray(items) ? items : []) {
      if (!samplePath(it?.zip) || !/\/[a-z0-9-]+\.zip$/.test(it.zip) || typeof it.name !== 'string') continue;
      const li = tpl.content.firstElementChild.cloneNode(true);
      const icon = li.querySelector('.sample-icon');
      if (samplePath(it.icon)) icon.src = it.icon;
      else icon.src = 'player/icons/icon-192.png';
      li.querySelector('.sample-name').textContent = it.name.slice(0, 60);
      li.querySelector('.sample-desc').textContent = String(it.description ?? '').slice(0, 200);
      const a = li.querySelector('.sample-download');
      a.href = it.zip;
      a.download = it.zip.slice(it.zip.lastIndexOf('/') + 1);
      const size = Number(it.size) > 0 ? ` · ${sampleSize(Number(it.size))}` : '';
      li.querySelector('.sample-label').textContent = `내려받기${size}`;
      a.setAttribute('aria-label', `${it.name.slice(0, 60)} 내려받기${size}`);
      list.append(li);
    }
    section.hidden = list.children.length === 0;
  } catch {
    section.hidden = true;
  }
  // 재료를 못 불러오면 C 길에 안내를 보인다
  document.getElementById('samples-empty').hidden = !section.hidden;
}
showSamples();

// 푸터 버전 (docs/SITES.md): player/version.js에서 번호만 읽는다(모듈이라 import하지 않음, update.js readVersion과 같은 규칙)
fetch('player/version.js')
  .then((res) => (res.ok ? res.text() : ''))
  .then((text) => {
    const v = /export\s+const\s+VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/.exec(text)?.[1];
    if (!v) return;
    document.getElementById('site-version').textContent = `v${v}`;
    document.getElementById('site-version-wrap').hidden = false;
  })
  .catch(() => {});
