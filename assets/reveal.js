// 랜딩 슬라이드 펼치기 (docs/SITES.md "슬라이드 펼치기"). 블록(.rv)을 위에서부터 하나씩 펼친다.
//   html.reveal-mode인 동안 화면 아래 20%를 그라데이션으로 가리고, 아직 안 펼친 블록은 흐리게 미리 보인다.
//   블록이 화면 위 80% 안으로 들어오면 그 블록과 앞의 블록을 펼쳐 재생한다(.is-on, 'rv:on').
//   (스크롤마다 다음 블록에서 되돌리던 v2.27.140 방식은 폰에서 덜컥거려 뺐다.)
//   멈춤 지점([data-stop], 사용자가 정한 10곳): 아래로 스크롤하다 지점의 위쪽이 위 여백(TOP)을 지나면 그 자리에 한 번 맞추고
//   스크롤을 잠가(html.reveal-hold, overflow hidden) 관성을 끊는다. HOLD_MS가 지나면 풀어 다음 스크롤은 다음 지점까지 간다
//   (휠·키 입력으로 잠금을 늘리지 않는다: 늘리면 계속 돌리는 동안 영영 안 풀린다. 손가락을 대고 있는 동안만 붙든다). 지점마다 처음 한 번만 멈춘다. 관성을 계속 되돌리지 않으므로 덜컥거리지 않는다.
//   다 펼치면 reveal-mode를 지워 가림 없이 훑는다. 동작 줄이기·JS 없음이면 아무것도 하지 않는다(처음부터 모두 보인다).
//   글은 바꾸지 않고 class만 바꾼다.
const blocks = [...document.querySelectorAll('.rv')];
const root = document.documentElement;

if (blocks.length > 1 && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let shown = -1;
  const TOP = 16; // 멈출 때 위 여백
  const HOLD_MS = 600; // 멈추는 시간
  const stops = [...document.querySelectorAll('[data-stop]')];
  const passed = new Set(); // 이미 멈췄던 지점
  let lastY = scrollY;
  let held = 0; // 잠근 시각 (0이면 안 잠김)
  let heldY = 0; // 멈춘 위치
  let touching = false;
  // 문서 위에서부터의 위치. 펼치는 중인 블록의 이동(transform)에 흔들리지 않게 offsetTop으로 잰다
  const topOf = (el) => {
    let y = 0;
    for (let e = el; e; e = e.offsetParent) y += e.offsetTop;
    return y - TOP;
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) reveal(blocks.indexOf(e.target));
  }, { rootMargin: '0px 0px -20% 0px' });

  // n번째 블록과 그 앞을 모두 펼친다
  function reveal(n) {
    n = Math.min(n, blocks.length - 1);
    if (n <= shown) return;
    for (let i = shown + 1; i <= n; i++) {
      blocks[i].classList.add('is-on');
      blocks[i].dispatchEvent(new Event('rv:on'));
      io.unobserve(blocks[i]);
    }
    shown = n;
    if (shown === blocks.length - 1) finish();
  }

  function finish() {
    io.disconnect();
    removeEventListener('scroll', onScroll);
    unhold();
    root.classList.remove('reveal-mode');
  }

  // 아래로 내려가다 처음 지난 멈춤 지점에 맞추고 잠근다
  function stopAt() {
    const y = scrollY;
    if (held || y <= lastY) return;
    for (const el of stops) {
      if (passed.has(el)) continue;
      const t = topOf(el);
      if (t > lastY && t <= y) {
        passed.add(el);
        heldY = t;
        scrollTo(0, t);
        hold();
        break;
      }
    }
  }

  function hold() {
    held = performance.now();
    root.classList.add('reveal-hold');
    setTimeout(tryRelease, HOLD_MS);
  }

  function tryRelease() {
    if (!held) return;
    const now = performance.now();
    const wait = held + HOLD_MS - now;
    if (touching || wait > 0) return void setTimeout(tryRelease, Math.max(wait, 50));
    unhold();
  }

  function unhold() {
    held = 0;
    root.classList.remove('reveal-hold');
  }

  // 손가락을 대고 있는 동안은 풀지 않는다(손을 떼면 풀 차례가 온다)
  addEventListener('touchstart', () => {
    if (held && performance.now() - held >= HOLD_MS) unhold(); // 멈춘 뒤 새로 미는 손가락은 바로 내려간다
    touching = true;
  }, { passive: true });
  addEventListener('touchend', () => { touching = false; }, { passive: true });
  addEventListener('touchcancel', () => { touching = false; }, { passive: true });

  // 맨 아래 블록(푸터 등)은 화면 위 80%까지 올라오지 못할 수 있으므로 페이지 끝에 닿으면 모두 펼친다
  function onScroll() {
    // 잠근 동안 손가락으로 끌고 있으면(overflow hidden이어도 이어지는 터치 스크롤) 멈춘 자리에 붙든다. 손을 떼면 관성은 잠금이 끊는다
    if (held && Math.abs(scrollY - heldY) > 1) {
      scrollTo(0, heldY);
      lastY = heldY;
      return;
    }
    stopAt();
    lastY = scrollY;
    if (scrollY + innerHeight >= root.scrollHeight - 2) reveal(blocks.length - 1);
  }

  // 초점(Tab)·주소의 #…·인쇄로 숨은 블록에 가면 그 블록까지 바로 펼친다
  const revealAt = (el) => {
    const b = el?.closest?.('.rv');
    if (!b) return;
    reveal(blocks.indexOf(b));
    for (const st of stops) if (st.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING || st.contains(b)) passed.add(st);
  };
  const revealHash = () => {
    try {
      revealAt(location.hash && document.querySelector(decodeURIComponent(location.hash)));
    } catch {} // 선택자로 쓸 수 없는 #… 는 무시
  };

  root.classList.add('reveal-mode');
  blocks.forEach((b) => io.observe(b));
  addEventListener('scroll', onScroll, { passive: true });
  // 새로고침으로 스크롤이 복원됐으면 위쪽 지점은 지난 것으로
  for (const st of stops) if (topOf(st) <= scrollY) passed.add(st);
  document.addEventListener('focusin', (e) => revealAt(e.target));
  addEventListener('hashchange', revealHash);
  addEventListener('beforeprint', () => reveal(blocks.length - 1));
  revealHash();
}
