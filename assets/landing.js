// 랜딩 (SPEC F-01, W-01). [비빔 설치하러 가기]는 HTML target="_blank"로 새 탭에서 연다(랜딩은 그대로 남는다).

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

// 웹앱 샘플 (SPEC F-01 1, 따라 하기 1단계): samples.json의 샘플 앱 목록과 [내려받기].
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
  // 샘플을 못 불러오면 1단계에 안내를 보인다
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
