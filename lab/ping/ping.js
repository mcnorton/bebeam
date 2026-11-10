// 핑 측정 (docs/FRIENDS.md §5.3, §7 T2·T7·T8)
// A: offer를 만들어 QR로 띄우고 기다린다. B의 answer는 받지 않는다.
// B: A의 offer를 읽어 answer까지 자기 쪽에만 적용한다 → B의 ICE가 A의 후보로 확인 요청(STUN)을 보낸다.
//    RFC 8445는 상대 정보를 받기 전에 온 확인 요청에도 곧바로 응답하라고 한다. B는 그 응답을 getStats로 센다.
// ICE 서버 없음, 내부망 주소만 (sdp.js가 걸러낸다).
import { compact, parseCompact, expand, readSdp, addrKind } from '../../player/js/transfer/sdp.js';
import { encode as b45encode, decode as b45decode } from '../../player/js/transfer/base45.js';
import { renderQR, createDetector } from '../../player/js/transfer/qr.js';
import { VERSION } from '../../player/version.js';

const $ = (id) => document.getElementById(id);
const GATHER_MS = 2000;
const PING_MS = 5000; // 이 안에 응답이 없으면 "닿지 않음"
const POLL_MS = 100;
const STORE_KEY = 'bebeam.lab.ping';
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── 기록 (이 기기에만, 실패해도 무시) ─────────
let records = [];
try { records = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { records = []; }
function showRecords() {
  $('count').textContent = records.length;
  $('log').textContent = records.map((r) => `${r.at.slice(5, 19)} ${r.role} ${r.result ?? ''} ${r.firstMs != null ? `첫 응답 ${r.firstMs}ms` : ''} ${r.rttMs != null ? `왕복 ${r.rttMs}ms` : ''} 보냄 ${r.sent ?? '-'} 받음 ${r.recv ?? '-'} [${(r.candidates || []).join(',')}] ${r.memo || ''}`).join('\n');
}
function record(r) {
  records.push({ at: new Date().toISOString(), v: VERSION, memo: $('memo').value.slice(0, 200), ua: navigator.userAgent, ...r });
  try { localStorage.setItem(STORE_KEY, JSON.stringify(records)); } catch { /* 무시 */ }
  showRecords();
}

const kinds = (sdp) => readSdp(sdp).candidates.map((c) => addrKind(c.addr));

function gather(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}

/** candidate-pair 통계 합계 */
async function pairStats(pc) {
  const s = { sent: 0, recv: 0, reqIn: 0, respOut: 0, pairsIn: 0, rtt: null };
  const stats = await pc.getStats();
  stats.forEach((p) => {
    if (p.type !== 'candidate-pair') return;
    s.sent += p.requestsSent ?? 0;
    s.recv += p.responsesReceived ?? 0;
    s.reqIn += p.requestsReceived ?? 0;
    s.respOut += p.responsesSent ?? 0;
    if (p.requestsReceived > 0) s.pairsIn++;
    const rtt = p.currentRoundTripTime ?? (p.responsesReceived ? p.totalRoundTripTime / p.responsesReceived : null);
    if (rtt != null && (s.rtt == null || rtt < s.rtt)) s.rtt = rtt;
  });
  return s;
}

// ───────── 코드 전달 ─────────
function tabsChannel() {
  const bc = new BroadcastChannel('bebeam.lab.ping');
  let timer = 0;
  return {
    show(code) { clearInterval(timer); const post = () => bc.postMessage({ code }); post(); timer = setInterval(post, 1000); },
    read() { return new Promise((res) => { bc.onmessage = (e) => { if (typeof e.data?.code === 'string') { bc.onmessage = null; res(e.data.code); } }; }); },
  };
}

async function qrChannel() {
  let detector = null;
  return {
    show(code) {
      const v = renderQR($('qr'), code, 'M');
      $('qrCap').textContent = `초대 QR v${v.version} · ${code.length}자`;
    },
    async read() {
      const video = $('video');
      if (!video.srcObject) {
        video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        await video.play();
      }
      detector ??= await createDetector();
      for (;;) {
        const text = await detector.detect(video).catch(() => null);
        if (text && readOffer(text)) return text;
        await sleep(100);
      }
    },
  };
}

function readOffer(code) {
  try {
    const f = parseCompact(b45decode(code));
    return f && f.kind === 'offer' ? f : null;
  } catch { return null; }
}

// ───────── A: 초대 띄우기 ─────────
async function runHost(channel) {
  $('hostView').hidden = false;
  if ($('camera').value === 'on') {
    // 카메라 권한이 있으면 브라우저가 실제 내부 IP를 후보로 낸다 (없으면 mDNS 이름). 열어 둔 채로 둔다.
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.createDataChannel('ping');
  await pc.setLocalDescription(await pc.createOffer());
  await gather(pc);
  let bytes;
  try { bytes = compact(pc.localDescription.sdp, 'offer'); } catch { bytes = null; }
  const cands = kinds(pc.localDescription.sdp);
  if (!bytes || !parseCompact(bytes)?.candidates.length) {
    $('hostStat').textContent = '내부망 주소가 없어요 (Wi-Fi에 연결돼 있나요?)';
    $('hostStat').className = 'big bad';
    record({ role: 'host', result: 'no-candidate', candidates: cands });
    return;
  }
  channel.show(b45encode(bytes));
  $('hostDetail').textContent = `내 후보: ${cands.join(', ')} · 이 화면을 켜 둔 채 B가 찍게 하세요`;
  record({ role: 'host', result: 'shown', candidates: cands });
  let last = 0;
  for (;;) {
    const s = await pairStats(pc);
    if (s.pairsIn !== last) {
      last = s.pairsIn;
      $('hostStat').textContent = `● 핑 보낸 기기(추정) ${s.pairsIn}대`;
      $('hostStat').className = 'big ok';
      record({ role: 'host', result: 'pinged', pingers: s.pairsIn, recv: s.reqIn, sent: s.respOut, candidates: cands });
    }
    $('hostDetail').textContent = `받은 확인 요청 ${s.reqIn} · 보낸 응답 ${s.respOut} · 내 후보: ${cands.join(', ')}`;
    await sleep(500);
  }
}

// ───────── B: 찍어서 핑 ─────────
async function runPinger(channel) {
  $('pingerView').hidden = false;
  $('again').hidden = true;
  $('pingStat').className = 'big';
  $('pingStat').textContent = $('signal').value === 'qr' ? 'A의 초대 QR을 비춰 주세요' : 'A 탭의 초대 코드를 기다리는 중';
  $('pingDetail').textContent = '';
  const code = await channel.read();
  const f = readOffer(code);
  const cands = kinds(expand(f));
  $('pingStat').textContent = '핑 보내는 중…';
  const pc = new RTCPeerConnection({ iceServers: [] });
  const t0 = now();
  await pc.setRemoteDescription({ type: 'offer', sdp: expand(f) });
  await pc.setLocalDescription(await pc.createAnswer()); // 여기서 B의 ICE가 A의 후보로 확인 요청을 보내기 시작한다. answer는 A에게 보내지 않는다.
  let first = null;
  let s = null;
  while (now() - t0 < PING_MS) {
    s = await pairStats(pc);
    if (s.recv > 0) { first = Math.round(now() - t0); break; }
    $('pingDetail').textContent = `보낸 확인 요청 ${s.sent} · A 후보: ${cands.join(', ')}`;
    await sleep(POLL_MS);
  }
  if (first != null) await sleep(300); // 왕복 시간 값이 채워질 때까지 잠깐
  s = await pairStats(pc);
  const rttMs = s.rtt != null ? Math.round(s.rtt * 1000) : null;
  const result = first != null ? 'ok' : s.sent > 0 ? 'no-response' : 'no-route';
  const text = {
    'ok': [`● 응답 있음${rttMs != null ? ` · 왕복 ${rttMs}ms` : ''}`, `첫 응답 ${first}ms · 같은 내부망에서 닿아요`, 'ok'],
    'no-response': ['✕ 응답 없음', `확인 요청 ${s.sent}번 보냈지만 ${PING_MS / 1000}초 동안 답이 없어요 (다른 망, 기기 간 차단, 또는 브라우저가 답 전에는 응답하지 않음)`, 'bad'],
    'no-route': ['✕ 보내지 못함', `A의 주소로 확인 요청을 보내지 못했어요 (mDNS 이름을 찾지 못했거나 경로 없음). A에서 "카메라 켜고"로 다시 해 보세요`, 'bad'],
  }[result];
  $('pingStat').textContent = text[0];
  $('pingStat').className = `big ${text[2]}`;
  $('pingDetail').textContent = `${text[1]} · A 후보: ${cands.join(', ')} · ICE ${pc.iceConnectionState}`;
  record({ role: 'pinger', result, firstMs: first, rttMs, sent: s.sent, recv: s.recv, iceState: pc.iceConnectionState, candidates: cands });
  pc.close();
  $('again').hidden = false;
}

// ───────── 시작 ─────────
let channel = null;
async function start() {
  $('setup').hidden = true;
  const role = document.querySelector('input[name=role]:checked').value;
  try {
    channel = $('signal').value === 'qr' ? await qrChannel() : tabsChannel();
    await (role === 'host' ? runHost(channel) : runPinger(channel));
  } catch (e) {
    const el = role === 'host' ? $('hostStat') : $('pingStat');
    el.textContent = `멈춤: ${e.message}`;
    el.className = 'big bad';
    record({ role, result: 'error', error: e.message });
  }
}

$('start').addEventListener('click', start);
$('again').addEventListener('click', () => runPinger(channel).catch((e) => { $('pingStat').textContent = `멈춤: ${e.message}`; }));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(records, null, 2)); $('copy').textContent = '복사함'; }
  catch { $('log').textContent = JSON.stringify(records); }
  setTimeout(() => { $('copy').textContent = 'JSON 복사'; }, 1500);
});
$('clear').addEventListener('click', () => {
  records = [];
  try { localStorage.removeItem(STORE_KEY); } catch { /* 무시 */ }
  showRecords();
});
$('ver').textContent = `v${VERSION}`;
$('env').textContent = navigator.userAgent;
showRecords();
