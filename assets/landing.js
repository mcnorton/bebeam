// 랜딩 (SPEC F-01 2, W-01): [플레이어 실행]은 새 창에서 연다. 팝업이 막히면 같은 창으로 이동한다.
//   noopener를 넘기면 window.open이 항상 null을 돌려줘 차단 여부를 알 수 없으므로, 연 뒤에 opener를 끊는다.

const link = document.getElementById('launch');
link.addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 브라우저 기본 동작(새 탭 등)
  e.preventDefault();
  const w = window.open(link.href, '_blank');
  if (w) w.opener = null;
  else location.href = link.href;
});
