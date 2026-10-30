// 장면 그림. 편마다 장면 함수 배열이고, 함수는 그림 속 문구(u)를 받아 HTML을 돌려준다.
//   문구는 모두 text.js의 고정 문자열이다 (사용자 입력이 들어가지 않는다).
//   data-qr: 계속 바뀌는 QR, data-type: 글자가 하나씩 써지는 칸 (main.js가 움직인다)

const tap = (d = 0.6) => `<span class="tap" style="--d:${d}s"></span>`;
const ui = (label, { cls = '', hl = false, d } = {}) =>
  `<span class="ui ${cls}${hl ? ' hl' : ''}">${label}${hl ? tap(d) : ''}</span>`;
// 폰은 나무틀·청동 리벳의 마법 석판, PC는 놋쇠 테 수정 거울. 화면(.scr) 안은 실제 화면을 단순하게
const phone = (inner, cls = '', d) =>
  `<div class="phone ${cls}"${d === undefined ? '' : ` style="--d:${d}s"`}><div class="frame"><div class="scr">${inner}</div></div></div>`;
const pc = (inner) => `<div class="pc"><div class="mirror"><div class="frame"><div class="scr">${inner}</div></div></div><div class="pc-stand"></div></div>`;
const addr = (url, typed = false) =>
  `<div class="addr">🔒 <b${typed ? ` data-type="${url}"` : ''}>${typed ? '' : url}</b></div>`;
const logo = (cls = '') => `<img class="logo ${cls}" src="icon.png" alt="">`;
// QR은 청록으로 빛나는 문양. 둘레에 반짝이 셋
const qr = (cls = '') => `<div class="sigil ${cls}"><div class="qr" data-qr></div><i class="spark s1"></i><i class="spark s2"></i><i class="spark s3"></i></div>`;

/** 3편: 보내는 사람(위)·받는 사람(아래), 폰 위에 역할 꼬리표. 빈 쪽은 그리지 않는다. gap은 두 사람 사이(거리 표시 등) */
function duo(u, top, bottom, gap = '') {
  const side = (kind, label, body) => (body ? `<div class="role"><span class="role-tag ${kind}">${label}</span>${body}</div>` : '');
  return `<div class="col duo">${side('send', u.send, top)}${top && bottom ? gap : ''}${side('recv', u.receive, bottom)}</div>`;
}
/** 3편: QR을 띄운 보내는 폰 */
const sending = (u) => phone(`<div class="titlebar">📤 ${u.sending}</div><div class="center">${qr()}</div>`, 'short');

/** 플레이어 목록 화면: 타이틀바, 앱 줄들, 아래 버튼 */
function player(u, { items = [], bottom = true, hlAdd = false, hlReceive = false, extra = '' } = {}) {
  const rows = items.map(
    (it) => `<div class="item${it.on ? ' on' : ''}"><span class="ico">${it.icon ?? '🐰'}</span>${it.name}${it.sub ? `<span class="tiny muted">${it.sub}</span>` : ''}<span class="dot3">⋯</span></div>`,
  ).join('');
  return `
    <div class="titlebar">${logo('sm')} BeBeam <span class="grow"></span>🌙 ⚙︎</div>
    ${rows || (extra ? '' : `<p class="center small muted">${u.empty}</p>`)}
    ${bottom ? `<div class="bottom">${ui(u.add, { hl: hlAdd })}${ui(u.receive, { cls: 'line', hl: hlReceive })}</div>` : ''}
    ${extra}`;
}

/** 뷰어(앱을 고른 화면): 이름과 [실행하기]·[앱 보내기] */
function viewer(u, { hlPlay = false, hlSend = false } = {}) {
  return `
    <div class="titlebar">${logo('sm')} BeBeam</div>
    <div class="cam" style="background:#3a3f4a">
      <div class="col" style="color:#fff">
        <span class="big">🐰</span>
        <span class="small">${u.appName}</span>
        ${ui(u.play, { hl: hlPlay })}
        ${ui(u.send, { cls: 'line', hl: hlSend })}
      </div>
    </div>`;
}

export const SCENES = [
  // 1편 플레이어 설치
  [
    // 컴퓨터는 [앱 목록 | 실행 화면], 폰은 [실행 화면 / 앱 목록] (플레이어의 실제 배치). 가운데 주고받기 화살표
    (u) => {
      const list = `<div class="split-list">${player(u, { items: [{ name: u.appName, on: true }, { name: u.app2, icon: '📝' }] })}</div>`;
      const view = '<div class="split-view"><div class="game"><span class="bunny">🐰</span></div></div>';
      return `<div class="row stack">${pc(`<div class="split">${list}${view}</div>`)}<span class="swap pop"></span>${phone(`${view}${list}`)}</div>`;
    },
    (u) => pc(`${addr('www.bebeam.net', true)}<div class="center muted small in" style="--d:1.6s">${logo()}<br>BeBeam</div>`),
    (u) => pc(`${addr('www.bebeam.net')}<div class="center col">${logo()}<span class="small">비빔 BeBeam</span>${ui(`▶ ${u.run}`, { hl: true })}</div>`),
    (u) => `<div class="row stack">
      ${pc(`${addr('www.bebeam.net/player/')}<div class="dialog pop" style="--d:.3s"><h4>${u.installAsk}</h4><div class="row" style="justify-content:flex-end;gap:.4em">${ui(u.cancel, { cls: 'line' })}${ui(u.install, { hl: true, d: 1 })}</div></div>`)}
      ${phone(`${addr('bebeam.net')}<div class="sheet slide-up" style="--d:.5s"><h4>${u.installAsk}</h4>${ui(u.install, { cls: 'wide', hl: true, d: 1.4 })}</div>`)}
    </div>`,
    (u) => `<div class="row">
      ${phone(`${addr('bebeam.net')}<div class="center">${logo()}</div><div class="bottom" style="justify-content:space-around"><span class="small">‹</span><span class="small">›</span><span class="ui line hl">⬆︎${tap(0.4)}</span><span class="small">📖</span></div>`)}
      <span class="arrow">→</span>
      ${phone(`<div class="sheet slide-up" style="--d:.3s"><h4>${u.share}</h4><span class="ui line wide">📋 Copy</span><span class="ui line wide hl" style="--d:1s">＋ ${u.addHome}${tap(1.2)}</span></div>`)}
    </div>`,
    (u) => `<div class="row">
      ${phone(`<div class="home-grid"><span></span><span></span><span></span><span></span><span class="hl" style="background:none">${logo()}${tap(1)}</span><span></span></div><div class="center small muted">📶✕ ${u.offline}</div>`)}
      <span class="arrow">→</span>
      ${phone(player(u), 'in', 1.8)}
    </div>`,
  ],
  // 2편 앱 추가·실행
  [
    (u) => phone(player(u, { hlAdd: true })),
    (u) => phone(player(u, {
      bottom: false,
      extra: `<div class="sheet slide-up"><h4>${u.add.replace('＋ ', '')}</h4>
        <span class="ui line wide" style="position:relative">📁 ${u.addFolder}<span class="badge">${u.onPc}</span></span>
        <span class="ui line wide" style="position:relative">🗜️ ${u.addZip}<span class="badge">${u.onPhone}</span></span>
        <span class="ui line wide">📷 ${u.qr}</span></div>`,
    })),
    (u) => `<div class="folder">
      <div>📁 jump-bunny/</div>
      <div class="file glow in" style="--d:.3s">📄 index.html ⭐</div>
      <div class="file in" style="--d:.6s">📄 style.css</div>
      <div class="file in" style="--d:.8s">📄 main.js</div>
      <div class="file in" style="--d:1s">🖼️ screenshot.webp</div>
    </div>`,
    (u) => phone(player(u, {
      bottom: false,
      extra: `<div class="dialog pop"><h4>${u.appInstall}</h4>
        <div class="row" style="justify-content:flex-start;gap:.4em"><span class="ico">🐰</span><span class="small">${u.appName}</span></div>
        <div class="kv">${u.files}<b>4</b></div><div class="kv">${u.size}<b>120 KB</b></div>
        <div class="row" style="justify-content:flex-end;gap:.4em">${ui(u.cancel, { cls: 'line' })}${ui(u.install, { hl: true, d: 1 })}</div></div>`,
    })),
    (u) => `<div class="row">${phone(player(u, { items: [{ name: u.appName, on: true }] }))}<span class="arrow">→</span>${phone(viewer(u, { hlPlay: true }))}</div>`,
    (u) => phone(`<div class="game"><span class="bunny">🐰</span><span class="x-btn hl">✕${tap(1.4)}</span></div>`),
    (u) => phone(player(u, {
      items: [{ name: u.appName, on: true }, { name: u.app2, icon: '📝' }],
      extra: `<div class="menu-pop pop" style="--d:.3s"><span>✏️ ${u.rename}</span><span>📤 ${u.transfer}</span><span>↺ ${u.reset}</span><span class="sep" style="color:var(--danger)">🗑 ${u.remove}</span></div>`,
    })),
  ],
  // 3편 QR로 주고받기: 보내는 사람(위) / 받는 사람(아래), 폰 위에 역할 꼬리표
  [
    (u) => duo(u, phone(viewer(u, { hlSend: true }), 'short'), phone(player(u, {}), 'short')),
    (u) => duo(u, phone(`<div class="titlebar">📤 ${u.sending}</div><div class="center col">${qr()}<span class="tiny muted">${u.appName}</span></div>`, 'short'), ''),
    (u) => duo(u, sending(u),
      `<div class="row">${phone(player(u, { hlReceive: true }), 'short')}<span class="arrow">→</span>${phone(`<div class="cam"><div class="cam-frame"></div><span class="tiny" style="position:absolute;bottom:.6em;color:#fff">${u.fitQr}</span></div>`, 'short')}</div>`),
    (u) => duo(u, sending(u), phone(`<div class="cam"><div class="cam-frame">${qr()}</div></div>`, 'short'), '<span class="dist v">15–30cm</span>'),
    (u) => duo(u, sending(u),
      `<div class="row" style="gap:.6em">${[0, 0.4, 0.8].map((d, i) => phone(`<div class="cam"><div class="cam-frame">${qr()}</div></div><div class="bar-track" style="margin:.3em"><div class="bar-fill" style="--t:${3 + i}s;--d:${d}s"></div></div><div class="tiny muted" style="padding:0 .4em">${u.left} 0:1${2 - i}</div>`, 'sm short')).join('')}</div>`),
    (u) => duo(u, '', phone(player(u, {
      bottom: false,
      extra: `<div class="dialog pop"><h4>${u.appInstall}</h4>
        <div class="row" style="justify-content:flex-start;gap:.4em"><span class="ico">🐰</span><span class="small">${u.appName}</span></div>
        <div class="kv">${u.from}<b>${u.sender}</b></div>
        <div class="row" style="justify-content:flex-end;gap:.4em">${ui(u.cancel, { cls: 'line' })}${ui(u.startInstall, { hl: true, d: 1 })}</div></div>`,
    }))),
    (u) => duo(u,
      phone(`<div class="titlebar">📤 ${u.sending}</div><div class="center col">${qr()}<span class="tiny muted">${u.speed}</span><div class="seg"><span class="hl">${u.slow}${tap(1)}</span><span class="on">${u.normal}</span><span>${u.fast}</span></div></div>`, 'short'),
      `<div class="tilt">${phone(`<div class="cam"><div class="cam-frame">${qr()}</div><div class="glare"></div></div>`, 'short')}</div>`),
  ],
  // 4편 AI로 앱 만들기
  [
    (u) => `<div class="row stack"><div class="col"><span class="big pop" style="font-size:3em">💡</span><span class="small muted in" style="--d:.4s">${u.idea}</span></div><span class="arrow">→</span>${pc(`<div class="titlebar">🤖 ${u.chat}</div><div class="chat"><div class="bubble in" style="--d:.9s">🙂</div></div>`)}</div>`,
    (u) => pc(`<div class="titlebar">🤖 ${u.chat}</div><div class="chat"></div><div class="input" data-type="${u.prompt}"></div>`),
    (u) => pc(`<div class="titlebar">🤖 ${u.chat}</div><div class="chat">
      <div class="bubble in" style="--d:.2s">${u.ask1}</div>
      <div class="bubble me in" style="--d:1s">${u.ans1}</div>
      <div class="bubble in" style="--d:1.8s">${u.ask2}</div>
      <div class="bubble me in" style="--d:2.6s">${u.ans2}</div></div>`),
    (u) => `<div class="row stack">${pc(`<div class="titlebar">🤖 ${u.chat}</div><div class="chat"><div class="bubble">✅ index.html, style.css, main.js</div></div>`)}<span class="arrow">→</span>
      <div class="folder"><div>📁 jump-bunny/</div>
      <div class="file glow pop" style="--d:.4s">📄 index.html</div>
      <div class="file pop" style="--d:.9s">📄 style.css</div>
      <div class="file pop" style="--d:1.4s">📄 main.js</div></div></div>`,
    (u) => `<div class="col"><div class="row"><div class="col"><span class="big">📁</span><span class="tiny">jump-bunny/</span></div><span class="arrow fly">→</span><div class="col pop" style="--d:.6s"><span class="big">🗜️</span><span class="tiny">jump-bunny.zip</span></div></div>
      <span class="arrow">↓</span>${phone(player(u, { items: [{ name: u.appName, on: true, sub: 'zip' }] }), 'in', 1.4)}</div>`,
    (u) => `<div class="col"><div class="url">https://www.bebeam.net/README.md</div>
      <div class="tiny muted">${u.promptLabel}</div><div class="prompt-box">${u.prompt}</div></div>`,
  ],
];

/** 11×11 QR 비슷한 무늬: 세 모서리는 채운 칸, 나머지는 무작위 */
export function qrCells(n = 11) {
  const corner = (x, y) => [[0, 0], [n - 3, 0], [0, n - 3]].some(([ox, oy]) => x >= ox && x < ox + 3 && y >= oy && y < oy + 3);
  let html = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      html += corner(x, y) || Math.random() < 0.5 ? '<i></i>' : '<i class="o"></i>';
    }
  }
  return html;
}
