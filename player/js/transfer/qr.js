// QR 생성(qrcode-generator)과 디코더 어댑터 (ARCHITECTURE §5.2)
// 디코더: BarcodeDetector가 qr_code를 지원하면 그것을, 아니면 zxing-wasm 워커를 쓴다 (jsQR은 R4 §2 벤치에서 제외).
// crop을 주면 영상의 그 정사각형만 읽는다(2.0 스캐너 칸). native는 원본 해상도, zxing은 MAX_CROP_SIDE까지 줄인다.

import qrcode from '../../vendor/qrcode-generator/qrcode.mjs';

const QUIET_ZONE = 4;
const MAX_GRAB_SIDE = 960;
const MAX_CROP_SIDE = 1280; // zxing에 넘기는 크롭 한 변 상한 (워커 전송·디코딩 시간)

/**
 * alphanumeric 모드 QR을 canvas에 정수 배율로 그린다.
 * @param {HTMLCanvasElement} canvas  CSS로 정사각형 크기가 정해져 있어야 한다
 * @param {string} text  base45 문자열
 * @param {'L'|'M'|'Q'|'H'} ecc
 * @param {number} [version] 고정할 QR 버전. 주면 짧은 데이터도 같은 밀도로 그린다(넘치면 자동). 0이면 자동
 * @returns {{version: number, modules: number}}
 */
export function renderQR(canvas, text, ecc = 'M', version = 0) {
  const make = (v) => {
    const q = qrcode(v, ecc);
    q.addData(text, 'Alphanumeric');
    q.make();
    return q;
  };
  let qr;
  try {
    qr = make(version);
  } catch {
    qr = make(0); // 고정 버전에 들어가지 않으면 자동으로
  }
  const n = qr.getModuleCount();
  const total = n + QUIET_ZONE * 2;
  const target = Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight) * (globalThis.devicePixelRatio || 1));
  const scale = Math.max(1, Math.floor(target / total));
  const px = total * scale;
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  // 검은 칸을 경로 하나에 모아 한 번에 칠한다 (v30이면 칸마다 fillRect를 부르면 프레임당 수천 번)
  ctx.beginPath();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.rect((c + QUIET_ZONE) * scale, (r + QUIET_ZONE) * scale, scale, scale);
    }
  }
  ctx.fillStyle = '#000';
  ctx.fill();
  return { version: (n - 17) / 4, modules: n };
}

/**
 * @param {{forceZxing?: boolean}} [opts]
 * @typedef {{sx: number, sy: number, side: number}} Crop
 * @returns {Promise<{kind: 'native'|'zxing', detect(source: HTMLVideoElement|HTMLCanvasElement, crop?: Crop): Promise<string|null>, dispose(): void}>}
 */
export async function createDetector({ forceZxing = false } = {}) {
  if (!forceZxing && 'BarcodeDetector' in globalThis) {
    try {
      const formats = await globalThis.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const d = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        return {
          kind: 'native',
          async detect(source, crop) {
            const src = crop ? await createImageBitmap(source, crop.sx, crop.sy, crop.side, crop.side) : source;
            try {
              const r = await d.detect(src);
              return r.length ? r[0].rawValue : null;
            } finally {
              if (src !== source) src.close();
            }
          },
          dispose() {},
        };
      }
    } catch { /* zxing으로 폴백 */ }
  }
  return createZxingDetector();
}

function createZxingDetector() {
  const worker = new Worker(new URL('./decoder.worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    p(data.text ?? null);
  };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return {
    kind: 'zxing',
    detect(source, crop) {
      const vw = source.videoWidth ?? source.width, vh = source.videoHeight ?? source.height;
      if (!vw || !vh) return Promise.resolve(null);
      const [sx, sy, sw, sh] = crop ? [crop.sx, crop.sy, crop.side, crop.side] : [0, 0, vw, vh];
      const s = Math.min(1, (crop ? MAX_CROP_SIDE : MAX_GRAB_SIDE) / Math.max(sw, sh));
      const w = Math.round(sw * s), h = Math.round(sh * s);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
      const image = ctx.getImageData(0, 0, w, h);
      const id = ++seq;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ id, image }, [image.data.buffer]);
      });
    },
    dispose() {
      worker.terminate();
      for (const resolve of pending.values()) resolve(null); // 기다리던 detect()를 끝낸다
      pending.clear();
    },
  };
}
