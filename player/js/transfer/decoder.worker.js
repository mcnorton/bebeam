// zxing-wasm QR 디코딩 워커. wasm은 CDN이 아닌 로컬 vendor 경로에서 읽는다 (vendor/README.md).

import { prepareZXingModule, readBarcodes } from '../../vendor/zxing-wasm/es/reader/index.js';

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL(`../../vendor/zxing-wasm/reader/${path}`, import.meta.url).href : prefix + path,
  },
  fireImmediately: true,
});

const OPTIONS = { formats: ['QRCode'], tryHarder: false, maxNumberOfSymbols: 1 };

self.onmessage = async ({ data: { id, image } }) => {
  try {
    const results = await readBarcodes(image, OPTIONS);
    const hit = results.find((r) => r.isValid);
    self.postMessage({ id, text: hit ? hit.text : null });
  } catch (e) {
    self.postMessage({ id, text: null, error: String(e) });
  }
};
