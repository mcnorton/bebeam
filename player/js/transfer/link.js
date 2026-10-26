// 광학 링크: 카메라 → 디코더 → session.onFrame,  session.nextFrame → base45 → QR 표시 (ARCHITECTURE §5.1, §5.2)
//   표시 주기(tick) 기본 8fps. 디코딩은 requestVideoFrameCallback으로 받고 이전 디코딩이 끝났을 때만 새로 제출한다.

import { encode, decode } from './base45.js';
import { renderQR, createDetector } from './qr.js';

export const DEFAULT_FPS = 8;

/** 카메라 오류를 사용자 문구로 (SPEC F-05 규칙 1) */
export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '카메라 권한이 필요합니다. 브라우저 주소창의 카메라 아이콘이나 설정에서 이 사이트의 카메라를 허용해 주세요. 보내는 쪽도 상대의 화면을 읽어야 해서 카메라가 필요합니다.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '사용할 수 있는 카메라를 찾지 못했습니다.';
    case 'NotReadableError':
      return '다른 앱이 카메라를 쓰고 있습니다. 그 앱을 닫고 다시 시도해 주세요.';
    default:
      return '카메라를 열 수 없습니다.';
  }
}

/**
 * OS가 화면(viewport)을 기기 기본 방향에서 돌린 각도 0/90/180/270.
 * 전송 화면은 배치를 기기(카메라 위치)에 고정하므로, OS가 화면을 돌렸으면 그만큼 되돌려 그린다.
 */
export function screenAngle() {
  let angle = screen.orientation?.angle;
  if (typeof angle !== 'number' && typeof window.orientation === 'number') angle = (window.orientation + 360) % 360;
  return [0, 90, 180, 270].includes(angle) ? angle : 0;
}

export class OpticalLink {
  #session;
  #video;
  #canvas;
  #fps;
  #stream = null;
  #detector = null;
  #wakeLock = null;
  #timer = 0;
  #lastText = null;
  #running = false;
  #stopped = false;
  #onVisibility = () => this.#keepAwake();
  /** 화면 꺼짐 방지를 쓸 수 있는지 (UI 안내용) */
  wakeLockSupported = 'wakeLock' in navigator;
  stats = { decodeTries: 0, decodeHits: 0, qrVersion: 0 };

  /**
   * @param {{session: import('./session.js').TransferSession, video: HTMLVideoElement, canvas: HTMLCanvasElement, fps?: number}} o
   */
  constructor({ session, video, canvas, fps = DEFAULT_FPS }) {
    this.#session = session;
    this.#video = video;
    this.#canvas = canvas;
    this.#fps = fps;
  }

  get decoderKind() {
    return this.#detector?.kind ?? null;
  }

  /**
   * 카메라를 열고 두 루프를 시작한다. 카메라를 못 열면 그 오류를 그대로 던진다.
   * 권한 대기 중에 stop()이 불리면 얻은 카메라를 바로 끄고 루프를 시작하지 않는다.
   */
  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (this.#stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.#stream = stream;
    const detector = await createDetector();
    if (this.#stopped) {
      detector.dispose();
      this.stopCamera();
      return;
    }
    this.#detector = detector;
    this.#video.srcObject = this.#stream;
    this.#video.muted = true;
    this.#video.playsInline = true;
    await this.#video.play().catch(() => {});
    if (this.#stopped) return;
    this.#running = true;
    await this.#keepAwake();
    document.addEventListener('visibilitychange', this.#onVisibility);
    this.#timer = setInterval(() => this.#show(), 1000 / this.#fps);
    this.#show();
    this.#scheduleDecode();
  }

  /** 카메라만 끄고 QR 표시는 계속한다 (상대가 마지막 프레임을 읽을 수 있도록) */
  stopCamera() {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#detector?.dispose();
    this.#detector = null;
  }

  stop() {
    this.#stopped = true;
    this.#running = false;
    clearInterval(this.#timer);
    this.stopCamera();
    this.#video.srcObject = null;
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#wakeLock?.release?.().catch(() => {});
    this.#wakeLock = null;
  }

  /** 크기·방향이 바뀌면 다음 tick에 다시 그린다 */
  invalidate() {
    this.#lastText = null;
  }

  async #keepAwake() {
    if (!this.#running || document.visibilityState !== 'visible') return;
    if (this.#wakeLock && !this.#wakeLock.released) return;
    let lock = null;
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      lock = null;
    }
    if (!this.#running) {
      lock?.release?.().catch(() => {}); // 기다리는 동안 stop()됨
      return;
    }
    this.#wakeLock = lock ?? null;
  }

  #show() {
    if (!this.#running) return;
    const f = this.#session.nextFrame();
    const text = encode(f.bytes);
    if (text === this.#lastText) return;
    this.#lastText = text;
    try {
      this.stats.qrVersion = renderQR(this.#canvas, text, f.ecc).version;
    } catch {
      // 캔버스 크기가 0인 순간 등은 다음 tick에 다시 그린다
      this.#lastText = null;
    }
  }

  #scheduleDecode() {
    if (!this.#running || !this.#detector) return;
    const v = this.#video;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.#decodeOnce());
    else requestAnimationFrame(() => this.#decodeOnce());
  }

  async #decodeOnce() {
    const detector = this.#detector;
    if (!this.#running || !detector) return;
    let text = null;
    try {
      text = await detector.detect(this.#video);
    } catch {
      text = null;
    }
    if (detector !== this.#detector) return;
    this.stats.decodeTries++;
    if (text) {
      this.stats.decodeHits++;
      let bytes = null;
      try {
        bytes = decode(text);
      } catch {
        // base45가 아닌 QR (다른 서비스의 QR 등)
      }
      if (bytes) this.#session.onFrame(bytes);
    }
    this.#session.reportDecode(!!text);
    this.#scheduleDecode();
  }
}
