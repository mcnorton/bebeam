// 연결 유지 측정 (docs/FRIENDS.md §7 T5)
// 연결: 두 번 훑기 (A offer QR → B가 찍고 answer QR → A가 찍기). ICE 서버 없음, 내부망 주소만.
// 유지: 양쪽이 1초마다 신호(hb)를 보내고 상대는 바로 되돌려(ack) 왕복 시간을 잰다.
//       3초 넘게 아무것도 안 오면 "멈춤", 다시 오면 멈춘 시간을 남긴다. 화면 숨김·잠금(visibility, pagehide, freeze),
//       화면 꺼짐 방지 해제, ICE·채널 상태 변화를 같은 기록에 시각과 함께 남긴다 → 무엇 때문에 끊겼는지 본다.
// 기록은 localStorage에 쌓여 페이지를 다시 열어도(다음 날) 남는다.
import { compact, parseCompact, expand } from '../../player/js/transfer/sdp.js';
import { encode as b45encode, decode as b45decode } from '../../player/js/transfer/base45.js';
import { renderQR, createDetector } from '../../player/js/transfer/qr.js';
import { VERSION } from '../../player/version.js';

const $ = (id) => document.getElementById(id);
const GATHER_MS = 2000;
const OPEN_MS = 15_000;
const HB_MS = 1000;
const STALL_MS = 3000;
const STORE_KEY = 'bebeam.lab.link';
const MAX_EVENTS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ───────── 기록 ─────────
let events = [];
try { events = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { events = []; }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(events.slice(-MAX_EVENTS))); } catch { /* 무시 */ } }, 200);
}
function ev(type, extra = {}) {
  events.push({ at: new Date().toISOString(), type, ...extra });
  save();
  showLog();
}
function showLog() {
  $('count').textContent = events.length;
  // 1초 신호는 기록하지 않는다 (상태 변화만). 최근 것이 위로
  $('log').textContent = events.slice(-200).reverse().map((e) => {
    const { at, type, ...rest } = e;
    const extra = Object.entries(rest).filter(([k]) => k !== 'ua').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    return `${at.slice(5, 19).replace('T', ' ')} ${type} ${extra}`;
  }).join('\n');
}

// ───────── WebRTC ─────────
function gather(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}
async function localCode(pc, kind) {
  await gather(pc);
  try {
    const bytes = compact(pc.localDescription.sdp, kind);
    return parseCompact(bytes)?.candidates.length ? b45encode(bytes) : null;
  } catch { return null; }
}
function readCode(code, kind) {
  try {
    const f = parseCompact(b45decode(code));
    return f && f.kind === kind ? f : null;
  } catch { return null; }
}

// ───────── 코드 전달 ─────────
function tabsChannel() {
  const bc = new BroadcastChannel('bebeam.lab.link');
  const timers = {};
  return {
    show(kind, code) { clearInterval(timers[kind]); const post = () => bc.postMessage({ kind, code }); post(); timers[kind] = setInterval(post, 1000); },
    stop() { Object.values(timers).forEach(clearInterval); },
    read(kind) {
      return new Promise((res) => {
        const h = (e) => { if (e.data?.kind === kind && readCode(e.data.code, kind)) { bc.removeEventListener('message', h); res(e.data.code); } };
        bc.addEventListener('message', h);
      });
    },
  };
}
function qrChannel() {
  let detector = null;
  const video = $('video');
  return {
    show(kind, code) {
      $('qr').hidden = false;
      video.hidden = true;
      renderQR($('qr'), code, 'M');
    },
    stop() {
      $('qr').hidden = true;
      video.hidden = true;
      video.srcObject?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
    async read(kind) {
      $('qr').hidden = true;
      video.hidden = false;
      if (!video.srcObject) {
        video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        await video.play();
      }
      detector ??= await createDetector();
      for (;;) {
        const text = await detector.detect(video).catch(() => null);
        if (text && readCode(text, kind)) return text;
        await sleep(100);
      }
    },
  };
}

// ───────── 연결 ─────────
async function pairAsA(ch) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('link', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  const code = await localCode(pc, 'offer');
  if (!code) throw new Error('내부망 주소가 없어요 (Wi-Fi에 연결돼 있나요?)');
  ch.show('offer', code);
  $('pairStat').textContent = '① B가 이 초대 QR을 찍게 하세요. 그다음 [B의 답 찍기]';
  await new Promise((res) => {
    const b = document.createElement('button');
    b.textContent = 'B의 답 찍기';
    b.className = 'primary';
    b.onclick = () => { b.remove(); res(); };
    if ($('signal').value === 'tabs') res(); else $('pair').append(b);
  });
  $('pairStat').textContent = '② B 화면의 답 QR을 비춰 주세요';
  const ans = readCode(await ch.read('answer'), 'answer');
  await pc.setRemoteDescription({ type: 'answer', sdp: expand(ans) });
  return { pc, dc };
}

async function pairAsB(ch) {
  $('pairStat').textContent = '① A의 초대 QR을 비춰 주세요';
  const offer = readCode(await ch.read('offer'), 'offer');
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dcP = new Promise((res) => pc.addEventListener('datachannel', (e) => res(e.channel), { once: true }));
  await pc.setRemoteDescription({ type: 'offer', sdp: expand(offer) });
  await pc.setLocalDescription(await pc.createAnswer());
  const code = await localCode(pc, 'answer');
  if (!code) throw new Error('내부망 주소가 없어요 (Wi-Fi에 연결돼 있나요?)');
  ch.show('answer', code);
  $('pairStat').textContent = '② 이 답 QR을 A가 찍게 하세요';
  return { pc, dc: await dcP };
}

function opened(dc) {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${OPEN_MS / 1000}초 안에 연결되지 않음`)), OPEN_MS);
    dc.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
  });
}

// ───────── 유지 측정 ─────────
const live = { since: 0, lastIn: 0, stalledAt: 0, stalls: 0, rtts: [], closedAt: 0 };

function watch(pc, dc) {
  dc.binaryType = 'arraybuffer';
  live.since = live.lastIn = Date.now();
  let seq = 0;
  dc.onmessage = (e) => {
    live.lastIn = Date.now();
    if (live.stalledAt) {
      ev('resume', { stalledMs: live.lastIn - live.stalledAt, visible: document.visibilityState });
      live.stalledAt = 0;
    }
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'hb' && Number.isInteger(m.seq)) { try { dc.send(JSON.stringify({ t: 'ack', seq: m.seq, ts: m.ts })); } catch { /* 닫힘 */ } }
    if (m.t === 'ack' && Number.isFinite(m.ts)) {
      live.rtts.push(performance.now() - m.ts);
      if (live.rtts.length > 300) live.rtts.shift();
    }
  };
  dc.onclose = () => { if (!live.closedAt) { live.closedAt = Date.now(); ev('channel-close', { uptimeMs: live.closedAt - live.since, visible: document.visibilityState }); } };
  pc.addEventListener('iceconnectionstatechange', () => ev('ice', { state: pc.iceConnectionState }));
  pc.addEventListener('connectionstatechange', () => ev('conn', { state: pc.connectionState }));
  setInterval(() => {
    if (dc.readyState === 'open') { try { dc.send(JSON.stringify({ t: 'hb', seq: seq++, ts: performance.now() })); } catch { /* 닫힘 */ } }
    const now = Date.now();
    if (!live.closedAt && !live.stalledAt && now - live.lastIn > STALL_MS) {
      live.stalledAt = live.lastIn;
      live.stalls++;
      ev('stall', { visible: document.visibilityState });
    }
    draw();
  }, HB_MS);
}

function draw() {
  const now = Date.now();
  const r = live.rtts;
  const avg = r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
  const last = r.length ? Math.round(r[r.length - 1]) : null;
  if (live.closedAt) {
    $('liveStat').textContent = `✕ 끊김 · 유지 ${clock(live.closedAt - live.since)}`;
    $('liveStat').className = 'big bad';
  } else if (live.stalledAt) {
    $('liveStat').textContent = `… 멈춤 ${Math.round((now - live.stalledAt) / 1000)}초 · 유지 ${clock(now - live.since)}`;
    $('liveStat').className = 'big bad';
  } else {
    $('liveStat').textContent = `● 연결 유지 ${clock(now - live.since)}`;
    $('liveStat').className = 'big ok';
  }
  $('liveDetail').textContent = `왕복 ${last ?? '-'}ms (최근 평균 ${avg ?? '-'}ms) · 멈춤 ${live.stalls}번`;
}

// ───────── 화면 꺼짐 방지 ─────────
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      ev('wake-on');
      wakeLock.addEventListener('release', () => { wakeLock = null; ev('wake-released', { visible: document.visibilityState }); });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch (e) {
    ev('wake-error', { error: e.message });
    $('wake').checked = false;
  }
}

// ───────── 페이지 생애 ─────────
document.addEventListener('visibilitychange', () => {
  ev('visibility', { state: document.visibilityState });
  if (document.visibilityState === 'visible' && $('wake').checked) setWake(true); // 숨겨지면 브라우저가 풀어 버린다
});
window.addEventListener('pagehide', (e) => ev('pagehide', { persisted: e.persisted }));
window.addEventListener('pageshow', (e) => { if (e.persisted) ev('pageshow', { persisted: true }); });
document.addEventListener('freeze', () => ev('freeze'));
document.addEventListener('resume', () => ev('resume-page'));
window.addEventListener('online', () => ev('online'));
window.addEventListener('offline', () => ev('offline'));

// ───────── 시작 ─────────
async function start() {
  $('setup').hidden = true;
  $('pair').hidden = false;
  const role = document.querySelector('input[name=role]:checked').value;
  const ch = $('signal').value === 'qr' ? qrChannel() : tabsChannel();
  ev('start', { role, memo: $('memo').value.slice(0, 200), v: VERSION, ua: navigator.userAgent });
  try {
    const { pc, dc } = role === 'a' ? await pairAsA(ch) : await pairAsB(ch);
    await opened(dc);
    ch.stop();
    $('pair').hidden = true;
    $('live').hidden = false;
    ev('connected', { role });
    watch(pc, dc);
    draw();
  } catch (e) {
    $('pairStat').textContent = `멈춤: ${e.message}`;
    $('pairStat').className = 'big bad';
    ev('error', { error: e.message });
  }
}

$('start').addEventListener('click', start);
$('wake').addEventListener('change', (e) => setWake(e.target.checked));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(events, null, 2)); $('copy').textContent = '복사함'; }
  catch { $('log').textContent = JSON.stringify(events); }
  setTimeout(() => { $('copy').textContent = 'JSON 복사'; }, 1500);
});
$('clear').addEventListener('click', () => {
  events = [];
  try { localStorage.removeItem(STORE_KEY); } catch { /* 무시 */ }
  showLog();
});
$('ver').textContent = `v${VERSION}`;
$('env').textContent = navigator.userAgent;
if (events.length) ev('reopen', { visible: document.visibilityState }); // 다시 열었을 때 (다음 날 등) 이전 기록과 이어서 본다
showLog();
