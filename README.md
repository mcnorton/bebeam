# BeBeam 앱 제작 규칙 (AI용)

> 이 문서는 **AI(Claude, ChatGPT, Gemini 등)가 먼저 읽는 문서**입니다.
> 주소: https://www.bebeam.net/README.md

## 0. AI에게

사용자가 BeBeam에서 쓸 앱을 만들어 달라고 했다면 아래 규칙을 지키세요.
- 결과물은 **`index.html`로 시작하는 폴더 하나**짜리 웹앱입니다. 빌드 도구 없이 바로 열려야 합니다.
- 다 만든 뒤에는 **§9 점검표**를 하나씩 스스로 확인하세요.
- 규칙을 지키지 못하는 기능을 요청받으면, 왜 안 되는지와 대안을 사용자에게 먼저 알려 주세요. 예: 외부 API 호출, 온라인 랭킹.

## 1. BeBeam이 무엇인가 (규칙의 이유)

**비빔 BeBeam**(https://www.bebeam.net/)은 내가 만든 작은 웹앱을 폰·태블릿·PC에 담아 실행하고, 친구에게 **네트워크 없이** 보내는 플레이어입니다. 설치형 PWA이며, 게임·수업자료·도구 같은 앱을 담습니다.

- **설치**
  - 사용자가 폴더나 zip을 넣으면, 플레이어가 파일을 기기 안(IndexedDB)에 저장합니다.
  - 서버에 올리지 않습니다.
- **실행**
  - 앱은 격리된 `sandbox` iframe(opaque origin) 안에서 실행됩니다.
  - 파일은 Blob URL로 된 가상 파일시스템으로 제공됩니다. 그래서 **앱 안의 상대경로만** 풀립니다.
  - **외부 통신은 CSP로 전부 막힙니다.** 받은 앱이 사용자 정보를 밖으로 보내지 못하게 하려는 것입니다.
  - 저장은 `localStorage`뿐이며, 플레이어가 앱마다 따로 보관합니다.
- **전송**
  - 앱 폴더를 zip으로 묶어 화면의 **QR 애니메이션**으로 보냅니다(단방향, fountain code).
  - 받는 사람은 카메라로 비추기만 합니다. 여러 명이 한 화면을 동시에 받을 수 있습니다.
  - 크기가 곧 전송 시간이므로 **작게** 만드는 것이 중요합니다.
- **화면**
  - 앱은 전체화면으로 실행됩니다.
  - 오른쪽 위에 플레이어의 반투명 ✕(종료) 버튼이 겹쳐 보입니다.
  - 대부분 폰에서 터치로 씁니다.

사용 설명: https://github.com/mcnorton/bebeam

## 2. 폴더 구조 — `index.html`로 시작

```
my-app/
├── index.html      ← 진입점 (폴더 맨 위, 필수)
├── style.css
├── main.js
├── icon.png
└── assets/
    ├── sprite.webp
    └── jump.mp3
```

- 폴더 **맨 위에 `index.html`**이 있어야 합니다. 상위 폴더 하나로 감싼 zip도 됩니다.
  - 이름은 정확히 소문자 `index.html`입니다. `Index.html`, `index.htm`이면 설치가 거부됩니다.
- 모든 참조는 **상대경로**로 씁니다. 예: `./assets/sprite.webp`, `assets/jump.mp3`.
  - `/`로 시작하는 절대경로는 쓰지 마세요.
  - `http://`, `https://`, `//`로 시작하는 주소도 쓰지 마세요.
- **경로 규칙**
  - 255자 이하
  - `..`(상위 폴더), 드라이브 문자(`C:`), 제어문자를 쓰지 않습니다. 하나라도 있으면 설치 전체가 거부됩니다.
  - 대소문자는 실제 파일명과 똑같이 씁니다.
- **자동 제외**: `.`으로 시작하는 파일·폴더, `node_modules/`, `__MACOSX/`, `Thumbs.db`.
- **빌드 없이 그대로 동작하는 HTML·CSS·JavaScript**로 만드는 것이 기본입니다.
  - 번들러(Vite 등)를 썼다면 빌드 결과 폴더(`dist/`)만 넣습니다.
  - 이때 base를 `./`로 설정해 상대경로가 되게 합니다.

## 3. 넣을 수 있는 파일

| 분류 | 확장자 |
|---|---|
| 문서 | html, htm |
| 스타일·스크립트 | css, js, mjs |
| 데이터 | json, txt, csv, xml, wasm |
| 이미지 | png, jpg, jpeg, gif, webp, avif, svg, ico, bmp |
| 오디오·비디오 | mp3, ogg, oga, wav, m4a, aac, flac, mp4, webm |
| 폰트 | woff, woff2, ttf, otf |

- 목록에 없는 파일(예: `.md`, `.ts`, `.jsx`, `.map`, `.zip`)은 설치할 때 **빠집니다**.
- 런타임에 필요한 파일은 위 확장자로 만드세요.

## 4. HTML·CSS·JavaScript 작성 규칙

### 되는 것
- ES 모듈: `<script type="module" src="main.js">`, `import { x } from './lib/x.js'`
- 문자열 리터럴로 쓴 dynamic import: `import('./levels/1.js')`
  - 모듈 파일(`.js`)이나 `type="module"` 스크립트 안에서만 됩니다.
- 앱 안 파일 읽기: `fetch('./data/words.json')`, `XMLHttpRequest`
- 코드로 경로를 만들어 쓰기: `img.src = 'assets/' + name + '.webp'`, `new Audio('assets/jump.mp3')`
  - JS로 풀리는 경로는 `img`·`audio`·`video`·`source`·`script`·`link`의 `src`·`href`(속성·`setAttribute`)뿐입니다.
  - `el.style.backgroundImage = 'url(…)'`처럼 **JS로 넣는 CSS `url()`은 풀리지 않습니다.** 배경 이미지는 CSS 파일에 클래스로 적어 두고 클래스를 바꾸거나, `<img>`를 씁니다.
  - `fetch`에는 문자열 경로를 넘깁니다(`new Request(…)` 객체는 쓰지 않습니다).
- canvas, WebGL, Web Audio, wasm, `requestAnimationFrame`
- 인라인 `<script>`·`<style>`, `eval`, `new Function`
- 전체화면, 게임패드, pointer lock, `alert`·`confirm`·`prompt`
- `<form>`: `submit` 이벤트에서 `e.preventDefault()`를 하고 JS로 처리합니다. action으로 제출하면 막힙니다.
- 단일 파일 Web Worker: `new Worker('worker.js')`
  - 워커 안에서는 import도 파일 읽기(`fetch`)도 안 됩니다. 필요한 데이터는 `postMessage`로 넘깁니다.
- 다른 HTML 페이지로 가는 링크(`<a href="page2.html">`): 클릭하면 같은 앱 안에서 이동하며 저장소를 함께 씁니다.
  - 화면 전환은 한 페이지 안에서 JS로 요소를 바꾸는 방식이 가장 안전합니다.
- 저장: **`localStorage`** (앱마다 5MB, 키와 값을 글자당 2바이트로 셈 = 약 260만 글자, 실행을 끝내도 남음)
  - `sessionStorage`는 실행을 끝내면 사라집니다.

### 안 되는 것 (조용히 실패하거나 오류가 납니다)
| 안 됨 | 대신 |
|---|---|
| CDN 스크립트·CSS (`<script src="https://cdn...">`) | 라이브러리 파일을 폴더에 넣고 상대경로로 |
| 웹 폰트 (Google Fonts 등) | woff2 파일을 넣거나 시스템 폰트 |
| 외부 API·`fetch('https://…')`·WebSocket·EventSource | 데이터는 JSON 파일로 포함. 온라인 기능은 만들 수 없음 |
| bare import (`import * as THREE from 'three'`) | `import * as THREE from './lib/three.module.js'` |
| 순환 import (a.js ↔ b.js) | 공통 부분을 별도 모듈로 분리 |
| **JS로 페이지 이동**: `location.href = …`, `location.reload()`, `location.assign()` | **앱이 강제 종료됩니다.** `<a href>` 클릭이나 한 페이지 안 화면 전환 |
| `<form action>` 제출 | `submit`에서 `preventDefault()` 후 JS 처리 |
| `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta http-equiv="refresh">` | `<a href>` 이동, `fetch`로 읽어 화면에 그리기 |
| 변수·템플릿으로 만든 import 경로 (`import('./lv' + n + '.js')`), 클래식 `<script>` 안의 `import()` | 정적 import로 모두 불러 두고 고르기, 데이터는 JSON + `fetch` |
| JS로 넣는 CSS `url()` (`style.backgroundImage`, `cssText`, 동적 `<style>`, `insertRule`) | CSS 파일의 클래스 바꾸기, `<img>` |
| `indexedDB`, 쿠키, Cache API, Service Worker | `localStorage`에 JSON으로 |
| WebRTC, `window.open`·팝업, `target="_top"`, 다운로드 | 앱 안 화면으로 처리 |
| 카메라·마이크·위치 | 사용 불가 |
| Worker 안의 `import`·`importScripts` | 워커는 파일 하나로 |
| 외부 링크(`<a href="https://…">`) | 앱 밖으로 나갈 수 없음 |

라이브러리는 **ES 모듈 빌드(`*.module.js`, `*.esm.js`)** 나 전역 스크립트 빌드(`*.min.js`) 파일을 폴더에 넣어 쓰세요.

## 5. 메타데이터 (목록에 예쁘게 보이게)

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>점프 토끼</title>                                   <!-- 앱 이름, 60자까지 -->
  <meta name="description" content="화면을 눌러 토끼를 점프시키는 게임">  <!-- 설명, 200자까지 -->
  <link rel="icon" href="icon.png">                          <!-- 목록 아이콘 (앱 안의 정사각형 PNG·SVG 파일. data:·외부 주소는 무시) -->
  <meta property="og:image" content="cover.webp">            <!-- 실행 전 뷰어 배경 (선택) -->
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <script type="module" src="main.js"></script>
</body>
</html>
```

- `<title>`이 없으면 폴더 이름이 앱 이름이 됩니다.
- 아이콘이 없으면 `favicon.ico`·`favicon.png`·`favicon.svg`·`icon.png` 순서로 찾습니다.

## 6. 화면

- **세로와 가로 모두** 깨지지 않게 만드세요(`100dvh`, flex/grid, `vmin`).
- **터치 우선**
  - 버튼은 최소 44px로 만듭니다.
  - 게임 화면에는 `touch-action: none`을 씁니다.
  - hover에만 기대지 않습니다.
- 오른쪽 위 모서리(약 56×56px, 노치 기기는 안전영역만큼 더 안쪽)는 플레이어의 ✕ 버튼이 덮습니다. 중요한 버튼을 두지 마세요.
- 인터넷이 없어도 동작해야 합니다(실제로 오프라인에서 실행됩니다).
- 글꼴은 시스템 글꼴(`system-ui, sans-serif`)을 권장합니다. 폰트 파일은 용량이 큽니다.

## 7. 용량과 전송 시간

| 항목 | 상한 |
|---|---|
| 앱 전체 (압축 풀었을 때) | 50MB |
| 파일 수 | 1,000개 |
| 파일 하나 | 20MB |
| **전송 권장 (zip 압축 후)** | **2MB 이하** (넘으면 예상 시간을 경고, 막지는 않음) |

- **QR 전송은 대략 1MB에 1분 정도** 걸립니다. 보통 속도 기준이며, 기기와 조명에 따라 더 걸립니다.
  - **압축 후 1MB 이하를 목표로** 하세요. 수업 시간에 여러 명이 기다리면서 받는다고 생각하면 됩니다.
- **줄이는 방법**
  - 이미지: webp로 저장하고, 화면에 보이는 크기에 맞춘 해상도로 만듭니다(보통 1024px 이하).
  - 오디오: 짧은 효과음은 mp3·ogg 64–96kbps로 만듭니다. 배경음악은 짧게 반복합니다.
  - 그림은 가능하면 canvas·SVG·CSS로 **코드로 그립니다**.
  - 큰 라이브러리(전체 three.js, 게임 엔진)보다 필요한 기능만 직접 짭니다.
  - 폰트 파일은 넣지 않거나, 쓰는 글자만 서브셋으로 만듭니다.
  - png·jpg·mp3·mp4는 이미 압축된 파일이라 zip으로 거의 줄지 않습니다. 코드·JSON은 많이 줄어듭니다.

## 8. BeBeam에 넣는 방법 (사용자에게 안내할 것)

1. https://www.bebeam.net/ 에서 [BeBeam 실행]을 누르고 플레이어를 설치합니다.
   - iPhone·iPad: 공유 → 홈 화면에 추가
   - Mac Safari: 파일 → Dock에 추가
2. 목록 아래 **[＋ 나의 앱 추가]**를 누르고 넣습니다.
   - **폴더 추가**: PC에서 `index.html`이 들어 있는 폴더를 선택합니다.
   - **zip 파일 추가**: 폴더를 zip으로 묶어 선택합니다. 폰에서는 이 방법을 씁니다.
3. 목록에서 앱을 고르고 ▶를 눌러 실행합니다.
4. 친구에게 보낼 때는 **[앱 보내기]**를 누릅니다. 친구는 **[앱 받기]**를 누르고 카메라로 QR을 비춥니다.

만들면서 PC에서 확인할 때는 파일을 더블클릭(`file://`)하지 마세요. 모듈·fetch가 막힙니다. 대신 폴더에서 `python3 -m http.server`를 실행하고 http://localhost:8000 으로 엽니다.

## 9. AI 자가 점검표

- [ ] 폴더 맨 위에 소문자 `index.html`이 있다
- [ ] `http://`, `https://`, `//`로 시작하는 참조가 **하나도 없다** (script, link, img, CSS `url()`, `import`, `fetch`)
- [ ] 모든 경로가 상대경로이고, 대소문자가 실제 파일명과 같다
- [ ] 모든 파일이 §3 허용 확장자다 (`.ts`·`.jsx`는 빌드 결과로 바꿨다)
- [ ] bare import·순환 import·변수로 만든 import 경로가 없다
- [ ] `location.href`·`location.reload()` 이동, `<iframe>`, form action 제출, JS로 넣는 CSS `url()`이 없다
- [ ] 저장은 `localStorage`만 쓴다 (indexedDB·쿠키 없음)
- [ ] `<title>`, `<meta name="description">`, `<link rel="icon">`이 있다
- [ ] 세로·가로, 폰 너비(360px)에서 깨지지 않고 터치로 조작된다
- [ ] 오른쪽 위 모서리에 중요한 버튼이 없다
- [ ] zip으로 압축하면 **2MB 이하**다 (목표 1MB)
- [ ] `python3 -m http.server`로 열고 인터넷을 끊어도 동작한다

## 10. 최소 예제

`index.html`
```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>탭 카운터</title>
  <meta name="description" content="화면을 누른 횟수를 세고 최고 기록을 저장해요">
  <link rel="icon" href="icon.svg">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <button id="tap">0</button>
  <p>최고 기록 <span id="best">0</span></p>
  <script type="module" src="main.js"></script>
</body>
</html>
```

`style.css`
```css
body { margin: 0; min-height: 100dvh; display: grid; place-content: center; gap: 16px;
       font-family: system-ui, sans-serif; text-align: center; touch-action: manipulation; }
#tap { width: 50vmin; height: 50vmin; border-radius: 50%; border: 0; font-size: 12vmin; }
```

`main.js`
```js
const tap = document.getElementById('tap');
const best = document.getElementById('best');
let count = 0;
best.textContent = localStorage.getItem('best') ?? 0;
tap.addEventListener('click', () => {
  tap.textContent = ++count;
  if (count > Number(best.textContent)) {
    best.textContent = count;
    localStorage.setItem('best', count);
  }
});
```

`icon.svg`
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2a6ae8"/><circle cx="32" cy="32" r="16" fill="#fff"/></svg>
```

SVG 안의 `xmlns="http://www.w3.org/2000/svg"`는 이름표일 뿐 외부 참조가 아니므로 괜찮습니다.
