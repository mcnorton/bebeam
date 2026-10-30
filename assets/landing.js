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
