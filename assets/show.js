// 랜딩 머리의 5장면 쇼 (docs/SITES.md "쇼", assets/show.css).
//   한 장면씩 보이며(.is-on) 장면 안 움직임은 CSS가 맡는다. 여기서는 장면 넘기기, 점·멈춤 버튼, 화면 밖이면 쉬기만 한다.
//   동작 줄이기 설정이면 시작하지 않는다(.is-live 없음 = 모든 장면 정지 그림). 글은 바꾸지 않고 class·aria만 바꾼다.
const show = document.getElementById('show');
if (show) {
  const scenes = [...show.querySelectorAll('.scene')];
  const dots = [...show.querySelectorAll('.dot')];
  const pause = show.querySelector('.pause');
  // 장면마다. 처음 보는 사람이 읽을 수 있게 넉넉히: 움직임이 끝난 뒤 머무는 시간을 3초 더 늘렸다(2026-11-11). ⑤는 끝에 이름 카드
  const DURATION = [12500, 11000, 11500, 10500, 15500];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  let timer = 0;
  let started = 0; // 이 장면을 보이기 시작한 시각
  let left = 0; // 멈췄다가 다시 갈 때 남은 시간
  let paused = false; // 사용자가 멈춤
  let away = false; // 화면 밖·탭 숨김

  const running = () => !paused && !away;

  function schedule(ms) {
    clearTimeout(timer);
    if (!running()) return;
    started = performance.now() - (DURATION[current] - ms);
    timer = setTimeout(() => go((current + 1) % scenes.length), ms);
  }

  function go(n) {
    current = n;
    scenes.forEach((s, i) => {
      s.classList.remove('is-on');
      s.setAttribute('aria-hidden', String(i !== n));
    });
    void scenes[n].offsetWidth; // 같은 장면으로 다시 와도 움직임이 처음부터 시작하게
    scenes[n].classList.add('is-on');
    dots.forEach((d, i) => d.setAttribute('aria-current', String(i === n)));
    left = DURATION[n];
    schedule(left);
  }

  function hold() {
    if (show.classList.contains('is-paused')) return; // 이미 쉬는 중 (멈춤 + 화면 밖이 겹칠 때)
    clearTimeout(timer);
    left = Math.max(0, DURATION[current] - (performance.now() - started));
    show.classList.add('is-paused');
  }

  function resume() {
    if (!running()) return;
    show.classList.remove('is-paused');
    schedule(left);
  }

  function setPaused(on) {
    paused = on;
    pause.setAttribute('aria-pressed', String(on));
    pause.textContent = on ? '▶ 재생' : '⏸ 멈춤';
    if (on) hold();
    else resume();
  }

  function start() {
    show.classList.add('is-live');
    go(0);
  }

  function stop() {
    clearTimeout(timer);
    show.classList.remove('is-live', 'is-paused');
    scenes.forEach((s) => {
      s.classList.remove('is-on');
      s.removeAttribute('aria-hidden');
    });
  }

  dots.forEach((d, i) => d.addEventListener('click', () => {
    go(i);
    if (paused) hold();
  }));
  pause.addEventListener('click', () => setPaused(!paused));

  // 화면 밖이거나 탭이 숨으면 쉰다 (배터리·주의를 아낀다)
  let offscreen = false;
  const updateAway = () => {
    const on = offscreen || document.hidden;
    if (on === away) return;
    away = on;
    if (!show.classList.contains('is-live')) return;
    if (on) hold();
    else resume();
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { offscreen = !e.isIntersecting; updateAway(); }).observe(show);
  }
  document.addEventListener('visibilitychange', updateAway);

  // 슬라이드 펼치기(assets/reveal.js)로 쇼 블록이 펼쳐지는 순간 ①장면부터 다시
  show.addEventListener('rv:on', () => {
    if (show.classList.contains('is-live')) go(0);
  });

  if (!reduce.matches) start();
  reduce.addEventListener?.('change', (e) => (e.matches ? stop() : start()));
}
