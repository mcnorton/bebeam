# vendor

외부 라이브러리를 빌드 없이 쓰기 위해 npm 패키지의 배포 파일을 그대로 복사해 둔다. 수정하지 않는다.

| 라이브러리 | 버전 | 라이선스 | 복사한 파일 | 용도 |
|---|---|---|---|---|
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.0.4 | MIT (파일 머리말) | `dist/qrcode.mjs` | QR 생성 |
| [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) | 3.1.6 | MIT (래퍼), 내장 zxing-cpp는 Apache-2.0 | `dist/es/share.js`, `dist/es/reader/index.js`, `dist/reader/zxing_reader.wasm` | QR 디코딩 폴백 |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | `esm/browser.js` → `fflate/fflate.js` | zip / deflate |
| [es-module-lexer](https://github.com/guybedford/es-module-lexer) | 3.0.4 | MIT | `dist/lexer.js` (wasm 내장) | JS import 분석 |
| [Neo둥근모 Pro](https://github.com/neodgm/neodgm-pro) | 1.020 | SIL OFL 1.1 (`neodgm-pro/LICENSE`) | 릴리스의 `NeoDunggeunmoPro-Regular.woff2` | 기본 글꼴 (플레이어·랜딩) |

## 주의

- **zxing-wasm**은 기본적으로 wasm을 CDN(jsdelivr)에서 받는다. 오프라인 동작을 위해 반드시 `prepareZXingModule({ overrides: { locateFile } })`로 `zxing-wasm/reader/zxing_reader.wasm` 로컬 경로를 지정한다.
- 갱신 절차: `npm pack <name>@<version>`으로 받은 뒤 위 파일만 교체하고, 이 표의 버전을 갱신한다. Neo둥근모 Pro는 npm 패키지가 아니므로 GitHub 릴리스에서 woff2를 받고 LICENSE.txt를 `LICENSE`로 둔다(sw-stamp가 `LICENSE`만 precache에서 뺀다).
- **Neo둥근모 Pro**는 16px 격자의 비트맵 글꼴이다. 16px 배수 크기에서 선명하고, 굵기가 하나뿐이라 `font-synthesis: none`으로 가짜 굵게를 막는다.
