// QR 생성(qrcode-generator)과 디코더 어댑터 (ARCHITECTURE §5.2)
// 디코더: BarcodeDetector가 qr_code를 지원하면 그것을, 아니면 zxing-wasm 워커를 쓴다.

import qrcode from '../../vendor/qrcode-generator/qrcode.mjs';

const QUIET_ZONE = 4;
const MAX_GRAB_SIDE = 960;

/**
 * alphanumeric 모드 QR을 canvas에 정수 배율로 그린다.
 * @param {HTMLCanvasElement} canvas  CSS로 정사각형 크기가 정해져 있어야 한다
 * @param {string} text  base45 문자열
 * @param {'L'|'M'|'Q'|'H'} ecc
 * @returns {{version: number, modules: number}}
 */
export function renderQR(canvas, text, ecc = 'M') {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Alphanumeric');
  qr.make();
  const n = qr.getModuleCount();
  const total = n + QUIET_ZONE * 2;
  const target = Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight) * (globalThis.devicePixelRatio || 1));
  const scale = Math.max(1, Math.floor(target / total));
  const px = total * scale;
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + QUIET_ZONE) * scale, (r + QUIET_ZONE) * scale, scale, scale);
    }
  }
  return { version: (n - 17) / 4, modules: n };
}

/**
 * @param {{forceZxing?: boolean}} [opts]
 * @returns {Promise<{kind: 'native'|'zxing', detect(source: HTMLVideoElement|HTMLCanvasElement): Promise<string|null>, dispose(): void}>}
 */
export async function createDetector({ forceZxing = false } = {}) {
  if (!forceZxing && 'BarcodeDetector' in globalThis) {
    try {
      const formats = await globalThis.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const d = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        return {
          kind: 'native',
          async detect(source) {
            const r = await d.detect(source);
            return r.length ? r[0].rawValue : null;
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
    detect(source) {
      const vw = source.videoWidth ?? source.width, vh = source.videoHeight ?? source.height;
      if (!vw || !vh) return Promise.resolve(null);
      const s = Math.min(1, MAX_GRAB_SIDE / Math.max(vw, vh));
      const w = Math.round(vw * s), h = Math.round(vh * s);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(source, 0, 0, w, h);
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
