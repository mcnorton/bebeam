// 내부망 고속 전송의 브라우저 어댑터 (M5, T5.6). session.js의 RtcAdapter를 RTCPeerConnection으로 구현한다.
//   ICE 서버는 쓰지 않는다(D5.1: 같은 내부망의 host 후보만, 외부 서버에 주소를 알리지 않는다).
//   축소 SDP(sdp.js)는 세션이 세션 키로 암호화해 QR로 주고받으므로, DTLS fingerprint로 맞대기 상대만 연결된다.
//   앱 샌드박스에서 RTCPeerConnection을 지우는 것(ARCHITECTURE §4.5)은 플레이어 셸과 무관하다.

import { compact, parseCompact, expand } from './sdp.js';
import { MAX_FRAME_SIZE } from './frame.js';

export const GATHER_MS = 2000; // non-trickle: 수집이 끝나거나 이 시간이 지나면 보낸다
const HIGH_WATER = 1024 * 1024; // 이만큼 쌓이면 보내기를 멈춘다
const LOW_WATER = 256 * 1024; // 이 아래로 내려가면 onDrain

function gather(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

export class RtcLink {
  onOpen = () => {};
  onClose = () => {};
  onDrain = () => {};
  onMessage = () => {};

  #pc = null;
  #dc = null;
  #closed = false;

  /** RTCPeerConnection이 있고 온라인일 때만 시도한다 (오프라인이면 후보도 없다) */
  get available() {
    return !this.#closed && typeof globalThis.RTCPeerConnection === 'function' && navigator.onLine !== false;
  }

  /** 송신자 */
  async createOffer() {
    const pc = this.#newPeer();
    this.#attach(pc.createDataChannel('bebeam', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    return this.#localCode('offer');
  }

  /** 수신자 */
  async acceptOffer(bytes) {
    const f = parseCompact(bytes);
    if (!f || f.kind !== 'offer') return null;
    const pc = this.#newPeer();
    // 처리기는 채널을 받는 즉시 붙인다. 늦게 붙이면 상대가 열리자마자 보낸 메시지를 놓친다 (T5.2 실기기)
    pc.addEventListener('datachannel', (e) => this.#attach(e.channel), { once: true });
    await pc.setRemoteDescription({ type: 'offer', sdp: expand(f) });
    await pc.setLocalDescription(await pc.createAnswer());
    return this.#localCode('answer');
  }

  /** 송신자 */
  async applyAnswer(bytes) {
    const f = parseCompact(bytes);
    if (!f || f.kind !== 'answer' || !this.#pc) throw new Error('bad answer');
    await this.#pc.setRemoteDescription({ type: 'answer', sdp: expand(f) });
  }

  canSend() {
    return this.#dc?.readyState === 'open' && this.#dc.bufferedAmount < HIGH_WATER;
  }

  send(frame) {
    if (!this.canSend()) return false;
    try {
      this.#dc.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.#closed = true;
    try { this.#dc?.close(); } catch { /* 이미 닫힘 */ }
    try { this.#pc?.close(); } catch { /* 이미 닫힘 */ }
    this.#dc = null;
    this.#pc = null;
  }

  #newPeer() {
    if (this.#pc || this.#closed) throw new Error('RtcLink는 한 번만 연결한다');
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' && !this.#closed) this.onClose();
    });
    this.#pc = pc;
    return pc;
  }

  #attach(dc) {
    this.#dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onmessage = (e) => {
      // 프레임 하나보다 큰 메시지나 문자열은 받지 않는다 (세션이 CRC·sid·형식을 다시 검사한다)
      if (e.data instanceof ArrayBuffer && e.data.byteLength <= MAX_FRAME_SIZE) this.onMessage(new Uint8Array(e.data));
    };
    dc.onopen = () => { if (!this.#closed) this.onOpen(); };
    dc.onclose = () => { if (!this.#closed) this.onClose(); };
    dc.onbufferedamountlow = () => { if (!this.#closed) this.onDrain(); };
  }

  /** 수집한 host 후보가 하나도 없으면 null (같은 망 연결이 불가능하다) */
  async #localCode(kind) {
    await gather(this.#pc);
    if (this.#closed || !this.#pc) return null;
    try {
      const bytes = compact(this.#pc.localDescription.sdp, kind);
      return parseCompact(bytes)?.candidates.length ? bytes : null;
    } catch {
      return null;
    }
  }
}
