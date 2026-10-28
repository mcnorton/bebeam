// 테마 미리 적용: 모듈(main.js)보다 먼저 동기로 읽어 첫 화면이 깜빡이지 않게 한다.
//   localStorage 'bebeam.ui.theme'이 'light' | 'dark'이면 <html data-theme>에 넣는다. 없으면 시스템 설정을 따른다.
(function () {
  try {
    var t = localStorage.getItem('bebeam.ui.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* 저장소를 못 쓰면 시스템 설정 */ }
})();
