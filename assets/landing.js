// 랜딩 (SPEC F-01 2, W-01): [BeBeam 실행](iOS·macOS Safari는 [BeBeam 설치하기])은 새 창에서 연다. 팝업이 막히면 같은 창으로 이동한다.
//   noopener를 넘기면 window.open이 항상 null을 돌려줘 차단 여부를 알 수 없으므로, 연 뒤에 opener를 끊는다.

const link = document.getElementById('launch');

// iOS(홈 화면)·macOS Safari(Dock)는 설치해야 플레이어를 쓸 수 있다(탭에서는 설치 안내만 보인다). 그래서 버튼 이름을 바꾼다.
// 판정은 player/js/ui/install-prompt.js isIos·isMacSafari와 같은 규칙 (iPadOS는 Mac처럼 보이므로 터치 지점 수로)
const ua = navigator.userAgent;
const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const macSafari = !ios && /Macintosh/.test(ua) && /Version\/[\d.]+.* Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
if (ios || macSafari) link.lastChild.textContent = ' BeBeam 설치하기';
link.addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 브라우저 기본 동작(새 탭 등)
  e.preventDefault();
  const w = window.open(link.href, '_blank');
  if (w) w.opener = null;
  else location.href = link.href;
});

// AI용 바이브 코딩 프롬프트·규칙 주소 [복사] (TASK T6.1). 버튼의 data-copy가 복사할 칸이다.
//   복사를 못 하면 칸을 선택해 두어 직접 복사하게 한다
const COPIED = { 'ai-prompt': '프롬프트를 복사했어요. AI 대화창에 붙여 넣으세요', 'ai-url': '주소를 복사했어요' };
const aiStatus = document.getElementById('ai-status');
let aiTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  const field = document.getElementById(button.dataset.copy);
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
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => { aiStatus.textContent = ''; }, 2500);
  });
}

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
