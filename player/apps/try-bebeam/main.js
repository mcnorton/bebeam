// 비빔 비벼보기: 레시피북. 표지 → 차례 → 편(왼쪽 쪽 그림, 오른쪽 쪽 비법 순서표, 장면마다 [다음]).
//   언어·본 편·표지를 펼쳤는지는 localStorage에 기억한다.
//   BeBeam 안에서도, 랜딩 iframe(sandbox, 저장소 없음)에서도 돌아야 하므로 저장은 실패해도 넘어간다.

import { TEXT, ROMAN } from './text.js';
import { SCENES, qrCells } from './scenes.js';
import { installArt } from './art.js';

const KEY_LANG = 'try-bebeam:lang';
const KEY_SEEN = 'try-bebeam:seen';
const KEY_OPENED = 'try-bebeam:opened';
const $ = (id) => document.getElementById(id);

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

let lang = load(KEY_LANG) ?? (/^ko\b/i.test(navigator.language ?? '') ? 'ko' : 'en');
if (!TEXT[lang]) lang = 'ko';
let seen = new Set();
try {
  seen = new Set(JSON.parse(load(KEY_SEEN) ?? '[]'));
} catch {}

let view = load(KEY_OPENED) ? 'toc' : 'cover'; // 'cover' | 'toc' | 'chapter'
let chapter = 0;
let scene = 0;
let timers = [];
let justSealed = -1; // 방금 마친 편: 차례에서 봉인이 찍힌다

const t = () => TEXT[lang];
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function clearTimers() {
  for (const id of timers) clearInterval(id);
  timers = [];
}

/** 장면 속 움직이는 부품: 바뀌는 QR, 한 글자씩 써지는 칸 */
function animate(stage) {
  for (const el of stage.querySelectorAll('[data-qr]')) {
    el.innerHTML = qrCells();
    if (!reduced()) timers.push(setInterval(() => { el.innerHTML = qrCells(); }, 350));
  }
  for (const el of stage.querySelectorAll('[data-type]')) {
    const full = [...el.dataset.type];
    if (reduced()) {
      el.textContent = full.join('');
      continue;
    }
    let i = 0;
    const id = setInterval(() => {
      el.textContent = full.slice(0, ++i).join('') + (i < full.length ? '▍' : '');
      if (i >= full.length) clearInterval(id);
    }, Math.max(25, 1400 / full.length));
    timers.push(id);
  }
}

/** 책장 넘김: 'next' | 'prev' | 'cover-leaf'. 연달아 누르면 마지막 것만 다시 시작한다 */
function turn(kind) {
  if (reduced()) return;
  const leaf = $('leaf');
  leaf.className = 'leaf';
  void leaf.offsetWidth; // 애니메이션을 처음부터 다시
  leaf.className = `leaf ${kind}`;
  // 애니메이션이 돌지 않는 환경에서도 종이가 쪽을 덮은 채 남지 않게
  clearTimeout(turn.timer);
  turn.timer = setTimeout(() => { leaf.className = 'leaf'; }, 500);
}

/** 장면 그림을 무대 안에 꽉 차게 (여백 6%, 최대 2배) */
function fit() {
  const stage = $('stage');
  const box = stage.firstElementChild;
  if (!box) return;
  box.style.transform = '';
  const k = Math.min((stage.clientWidth * 0.94) / box.offsetWidth, (stage.clientHeight * 0.94) / box.offsetHeight, 2);
  box.style.transform = `scale(${k})`;
}
new ResizeObserver(fit).observe($('stage'));

/** 여백 낙서·얼룩 위치: 쪽마다 다르되 늘 같게 (무작위 없음) */
function doodle(seed) {
  for (const [i, marg] of [...document.querySelectorAll('.marg')].entries()) {
    const n = seed * 7 + i * 13;
    marg.style.setProperty('--sx', `${8 + ((n * 37) % 60)}%`);
    marg.style.setProperty('--sy', `${12 + ((n * 53) % 55)}%`);
    marg.style.setProperty('--fx', `${4 + ((n * 29) % 18)}%`);
    marg.style.setProperty('--fy', `${4 + ((n * 17) % 8)}%`);
    marg.style.setProperty('--tx', `${20 + ((n * 41) % 55)}%`);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderTabs() {
  const s = t();
  const tabs = $('tabs');
  tabs.replaceChildren();
  s.chapters.forEach((ch, i) => {
    const b = el('button', `tab tab-${i + 1}${view === 'chapter' && chapter === i ? ' on' : ''}`, ROMAN[i]);
    b.type = 'button';
    b.setAttribute('aria-label', `${ROMAN[i]}. ${ch.recipe}`);
    b.addEventListener('click', () => open(i));
    tabs.append(b);
  });
}

function renderCover() {
  const s = t().book;
  $('cover-title').textContent = s.title;
  $('cover-sub').textContent = s.subtitle;
  $('open').textContent = s.open;
}

function renderToc() {
  const s = t();
  $('intro').textContent = s.book.intro;
  $('toc-title').textContent = s.book.contents;
  const list = $('contents');
  list.replaceChildren();
  s.chapters.forEach((ch, i) => {
    const li = el('li');
    const b = el('button', 'entry');
    b.type = 'button';
    b.append(el('span', 'entry-no', ROMAN[i]), el('span', 'entry-title', ch.recipe), el('span', 'entry-dots'), el('span', 'entry-count', s.scenes(ch.captions.length)));
    if (seen.has(i)) {
      const mark = el('span', i === justSealed ? 'seal stamp-in' : 'seal');
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', s.seen);
      b.append(mark);
    }
    b.addEventListener('click', () => open(i));
    li.append(b);
    list.append(li);
  });
  doodle(0);
  justSealed = -1;
}

function renderScene() {
  const s = t();
  const ch = s.chapters[chapter];
  const last = ch.captions.length - 1;
  clearTimers();
  $('kicker').textContent = ch.title;
  // 장식 첫 글자 자리에는 편 번호. 한글 제목은 첫 글자를 떼면 읽기 어렵다
  $('cap').textContent = ROMAN[chapter];
  $('recipe').textContent = ch.recipe;

  const steps = $('steps');
  steps.replaceChildren();
  ch.captions.forEach((c, i) => {
    const state = i < scene ? 'done' : i === scene ? 'now' : 'next';
    // 세로 한 쪽에서는 지금 단계 둘레만 보인다
    const far = Math.abs(i - scene) > 1 ? ' far' : '';
    const li = el('li', `${state}${far}`, c);
    li.dataset.n = `${i + 1}.`; // 세로에서 가린 줄이 있어도 번호가 맞게
    if (state === 'now') li.setAttribute('aria-current', 'step');
    steps.append(li);
  });

  const stage = $('stage');
  // 그림은 text.js의 고정 문자열로만 만든다
  stage.innerHTML = `<div class="fit">${SCENES[chapter][scene](s.ui)}</div>`;
  fit();
  // 잉크로 그려지듯 나타나기. 애니메이션이 돌지 않아도 그림이 가려진 채 남지 않게 시간이 지나면 뺀다
  if (!reduced()) {
    const box = stage.firstElementChild;
    box.classList.add('inking');
    clearTimeout(renderScene.inkTimer);
    renderScene.inkTimer = setTimeout(() => box.classList.remove('inking'), 750);
  }
  animate(stage);
  $('caption').textContent = ch.captions[scene];
  $('folio-left').textContent = `· ${ROMAN[chapter]} ·`;
  $('folio-right').textContent = `${scene + 1} / ${last + 1}`;
  $('prev').disabled = scene === 0;
  $('next').textContent = scene === last ? s.done : `${s.next} ▶`;
  if (scene === last && !seen.has(chapter)) {
    seen.add(chapter);
    justSealed = chapter;
    save(KEY_SEEN, JSON.stringify([...seen]));
  }
  doodle(chapter * 10 + scene + 1);
}

function render() {
  const s = t();
  document.documentElement.lang = lang;
  document.title = s.app;
  for (const b of document.querySelectorAll('.lang-pair .lang')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  $('prev').textContent = `◀ ${s.prev}`;
  $('toc-prev').textContent = s.book.close;
  $('back').setAttribute('aria-label', s.book.toContents);
  $('back').title = s.book.toContents;
  $('book').dataset.view = view;
  $('cover').hidden = view !== 'cover';
  $('toc').hidden = view !== 'toc';
  $('play').hidden = view !== 'chapter';
  $('back').hidden = view !== 'chapter';
  $('tabs').hidden = view === 'cover';
  if (view !== 'chapter') clearTimers();
  if (view === 'cover') renderCover();
  if (view === 'toc') renderToc();
  if (view === 'chapter') renderScene();
  if (view !== 'cover') renderTabs();
}

function open(i) {
  turn('next');
  view = 'chapter';
  chapter = i;
  scene = 0;
  render();
  $('next').focus();
}

function toToc() {
  const from = view === 'chapter' ? chapter : 0;
  turn(view === 'cover' ? 'cover-leaf' : 'prev');
  view = 'toc';
  render();
  $('contents').children[from]?.querySelector('button')?.focus();
}

/** 차례의 [이전], 마지막 편을 마친 [다음]: 표지로 */
function toCover() {
  view = 'cover';
  render();
  $('open').focus();
}

function next() {
  if (view !== 'chapter') return;
  if (scene < SCENES[chapter].length - 1) {
    scene++;
    turn('next');
    renderScene();
  } else if (chapter === SCENES.length - 1) {
    toCover();
  } else {
    toToc();
  }
}

function prev() {
  if (view === 'toc') return toCover();
  if (view !== 'chapter' || scene === 0) return;
  scene--;
  turn('prev');
  renderScene();
}

function toggleLang() {
  lang = lang === 'ko' ? 'en' : 'ko';
  save(KEY_LANG, lang);
  render();
}

// 책을 다시 펼치면 차례의 봉인을 모두 지운다
$('open').addEventListener('click', () => {
  save(KEY_OPENED, '1');
  seen.clear();
  justSealed = -1;
  save(KEY_SEEN, '[]');
  toToc();
});
$('next').addEventListener('click', next);
$('prev').addEventListener('click', prev);
$('back').addEventListener('click', toToc);
$('toc-prev').addEventListener('click', toCover);
for (const b of document.querySelectorAll('.lang-pair .lang')) {
  b.addEventListener('click', () => {
    if (b.dataset.lang !== lang) toggleLang();
  });
}
document.addEventListener('keydown', (e) => {
  if (view === 'cover' || e.altKey || e.ctrlKey || e.metaKey) return;
  // 버튼에 초점이 있으면 Enter·Space는 그 버튼이 처리한다
  const onButton = e.target instanceof HTMLButtonElement;
  if (view === 'chapter' && (e.key === 'ArrowRight' || (!onButton && (e.key === 'Enter' || e.key === ' ')))) {
    e.preventDefault();
    next();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    prev();
  } else if (e.key === 'Escape' && view === 'chapter') {
    toToc();
  }
});

installArt();
// #cover, #toc, #편-장면(예: #3-5)으로 열면 그 쪽부터 (시안·대표 스크린샷용)
const deep = /^#(?:(cover|toc)|(\d)-(\d))$/.exec(location.hash);
if (deep?.[1]) view = deep[1];
else if (deep && SCENES[deep[2] - 1]?.[deep[3] - 1]) {
  view = 'chapter';
  chapter = deep[2] - 1;
  scene = deep[3] - 1;
}
render();
