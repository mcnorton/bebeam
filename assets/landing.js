// 랜딩 (SPEC F-01 2, W-01): [BeBeam 실행](iOS는 [BeBeam 설치하기])은 새 창에서 연다. 팝업이 막히면 같은 창으로 이동한다.
//   noopener를 넘기면 window.open이 항상 null을 돌려줘 차단 여부를 알 수 없으므로, 연 뒤에 opener를 끊는다.

const link = document.getElementById('launch');

// iOS는 홈 화면에 추가해야 플레이어를 쓸 수 있다(플레이어가 탭에서는 설치 안내만 보인다). 그래서 버튼 이름을 바꾼다.
// 판정은 player/js/ui/install-prompt.js isIos와 같은 규칙 (iPadOS는 Mac처럼 보이므로 터치 지점 수로)
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (ios) link.lastChild.textContent = ' BeBeam 설치하기';
link.addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 브라우저 기본 동작(새 탭 등)
  e.preventDefault();
  const w = window.open(link.href, '_blank');
  if (w) w.opener = null;
  else location.href = link.href;
});
