// 광학 링크 (TASK T7.6, TRANSPORT §4)
//   송신 QrDisplay: sender.nextFrame → base45 → QR, sender.fps 주기 (속도를 바꾸면 다음 tick부터).
//   수신 QrScanner: 후면 카메라(기기 최대에 가까운 해상도) → 가운데 정사각형 크롭 → 디코더 → receiver.onFrame.
//   화면의 스캐너 칸도 같은 가운데 정사각형(object-fit: cover)을 보여준다.

import { encode, decode } from './base45.js';
import { renderQR, createDetector } from './qr.js';

/** 카메라 오류를 사용자 문구로 (2.0: 받는 쪽만 카메라를 쓴다) */
export function scannerErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '카메라 권한이 필요합니다. 브라우저 주소창의 카메라 아이콘이나 설정에서 이 사이트의 카메라를 허용해 주세요.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '사용할 수 있는 카메라를 찾지 못했습니다.';
    case 'NotReadableError':
      return '다른 앱이 카메라를 쓰고 있습니다. 그 앱을 닫고 다시 시도해 주세요.';
    default:
      return '카메라를 열 수 없습니다.';
  }
}

/** Screen Wake Lock: 화면이 다시 보이면 다시 잡는다 */
export class ScreenAwake {
  #lock = null;
  #on = false;
  #onVisibility = () => this.#acquire();
  supported = 'wakeLock' in navigator;

  async start() {
    this.#on = true;
    document.addEventListener('visibilitychange', this.#onVisibility);
    await this.#acquire();
  }

  stop() {
    this.#on = false;
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#lock?.release?.().catch(() => {});
    this.#lock = null;
  }

  async #acquire() {
    if (!this.#on || document.visibilityState !== 'visible') return;
    if (this.#lock && !this.#lock.released) return;
    let lock = null;
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      lock = null;
    }
    if (!this.#on) {
      lock?.release?.().catch(() => {}); // 기다리는 동안 stop()됨
      return;
    }
    this.#lock = lock ?? null;
  }
}

export class QrDisplay {
  #sender;
  #canvas;
  #timer = 0;
  #fps = 0;
  #lastText = null;
  #running = false;
  #awake = new ScreenAwake();

  /** @param {{sender: import('./broadcast.js').FountainSender, canvas: HTMLCanvasElement}} o */
  constructor({ sender, canvas }) {
    this.#sender = sender;
    this.#canvas = canvas;
  }

  get wakeLockSupported() {
    return this.#awake.supported;
  }

  async start() {
    this.#running = true;
    this.#arm();
    this.#show();
    this.#awake.start(); // 기다리지 않는다 (QrScanner와 같음)
  }

  stop() {
    this.#running = false;
    clearInterval(this.#timer);
    this.#awake.stop();
  }

  /** 크기·방향이 바뀌면 다음 tick에 다시 그린다 */
  invalidate() {
    this.#lastText = null;
  }

  #arm() {
    clearInterval(this.#timer);
    this.#fps = this.#sender.fps;
    this.#timer = setInterval(() => this.#show(), 1000 / this.#fps);
  }

  #show() {
    if (!this.#running) return;
    if (this.#sender.fps !== this.#fps) this.#arm();
    const f = this.#sender.nextFrame();
    const text = encode(f.bytes);
    if (text === this.#lastText) return;
    this.#lastText = text;
    try {
      renderQR(this.#canvas, text, f.ecc, f.version);
    } catch {
      this.#lastText = null; // 캔버스 크기가 0인 순간 등은 다음 tick에 다시 그린다
    }
  }
}

const DECODE_FALLBACK_MS = 150;

/** 영상 가운데 정사각형 (짧은 변 전체) */
export function centerCrop(vw, vh) {
  const side = Math.min(vw, vh);
  return { sx: Math.floor((vw - side) / 2), sy: Math.floor((vh - side) / 2), side };
}

export class QrScanner {
  #receiver;
  #video;
  #facing;
  #stream = null;
  #detector = null;
  #running = false;
  #stopped = false;
  #awake = new ScreenAwake();
  /** 진단(?diag)용 */
  stats = { width: 0, height: 0, crop: 0, decodeMs: 0, fps: 0 };
  #decodes = [];
  #token = 0;

  /**
   * @param {{receiver: import('./broadcast.js').FountainReceiver, video: HTMLVideoElement, facing?: 'environment'|'user'}} o
   */
  constructor({ receiver, video, facing = 'environment' }) {
    this.#receiver = receiver;
    this.#video = video;
    this.#facing = facing;
  }

  get facing() {
    return this.#facing;
  }

  get decoderKind() {
    return this.#detector?.kind ?? null;
  }

  /** 카메라를 열고 디코딩 루프를 시작한다. 카메라를 못 열면 그 오류를 그대로 던진다 */
  async start() {
    await this.#open();
    if (this.#stopped) return;
    const detector = await createDetector();
    if (this.#stopped) {
      detector.dispose();
      return;
    }
    this.#detector = detector;
    this.#running = true;
    this.#scheduleDecode();
    this.#awake.start(); // 기다리지 않는다: 권한·정책에 따라 끝나지 않을 수 있다(iframe 등)
  }

  /** 후면 ↔ 전면 */
  async switchCamera() {
    this.#facing = this.#facing === 'environment' ? 'user' : 'environment';
    this.#closeStream();
    await this.#open();
  }

  stop() {
    this.#stopped = true;
    this.#running = false;
    this.#closeStream();
    this.#video.srcObject = null;
    this.#detector?.dispose();
    this.#detector = null;
    this.#awake.stop();
  }

  async #open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: this.#facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    if (this.#stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.#stream = stream;
    const track = stream.getVideoTracks()[0];
    // 지원하면 연속 초점 (가까이 든 화면에 초점이 머물게)
    const caps = track?.getCapabilities?.() ?? {};
    if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    const set = track?.getSettings?.() ?? {};
    this.stats.width = set.width ?? 0;
    this.stats.height = set.height ?? 0;
    this.stats.fps = set.frameRate ?? 0;
    const v = this.#video;
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    v.classList.toggle('mirrored', this.#facing === 'user');
    await v.play().catch(() => {});
  }

  #closeStream() {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
  }

  /**
   * 새 영상 프레임마다 한 번 (이전 디코딩이 끝났을 때만). 영상 콜백이 오지 않는 경우(화면에 그려지지 않는 탭,
   * 일부 브라우저의 captureStream 등)를 위해 DECODE_FALLBACK_MS 타이머도 함께 건다. 먼저 오는 쪽만 쓴다.
   */
  #scheduleDecode() {
    if (!this.#running) return;
    const v = this.#video;
    const token = ++this.#token;
    const run = () => {
      if (token !== this.#token) return;
      this.#token++;
      this.#decodeOnce();
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(run);
    else requestAnimationFrame(run);
    setTimeout(run, DECODE_FALLBACK_MS);
  }

  async #decodeOnce() {
    const detector = this.#detector;
    const v = this.#video;
    if (!this.#running || !detector) return;
    let text = null;
    if (v.videoWidth && v.videoHeight) {
      const crop = centerCrop(v.videoWidth, v.videoHeight);
      this.stats.crop = crop.side;
      const t = performance.now();
      try {
        text = await detector.detect(v, crop);
      } catch {
        text = null;
      }
      this.#decodes.push(performance.now() - t);
      if (this.#decodes.length > 30) this.#decodes.shift();
      this.stats.decodeMs = this.#decodes.reduce((a, b) => a + b, 0) / this.#decodes.length;
    }
    if (detector !== this.#detector) return;
    if (text) {
      let bytes = null;
      try {
        bytes = decode(text);
      } catch {
        // base45가 아닌 QR (다른 서비스의 QR 등)
      }
      if (bytes) this.#receiver.onFrame(bytes);
    }
    this.#receiver.reportDecode(!!text);
    this.#scheduleDecode();
  }
}
