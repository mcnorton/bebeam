// 셸 프레임 회전 (W-04): 플레이어는 항상 가로로 쓴다.
//   폰·태블릿을 세로로 들었는데 OS가 가로로 고정해 주지 않으면(iOS, 브라우저 탭)
//   #frame(셸 + 안내 토스트)을 90° 돌려 그린다. 앱 실행 중에는 돌리지 않는다 (SPEC F-04 규칙 3).
//   <dialog>는 top layer라 프레임 회전을 받지 않으므로 CSS가 따로 돌린다 (html.tb-rotated).

export const ROTATED_CLASS = 'tb-rotated';

/** 손에 들고 돌릴 수 있는 기기 (폰·태블릿) */
export function isHandheld() {
  return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}

export function isRotated() {
  return document.documentElement.classList.contains(ROTATED_CLASS);
}

/** 떠 있는 요소(메뉴 등)를 붙일 곳: 회전 중이면 프레임 안, 아니면 body */
export function container() {
  return (isRotated() && document.getElementById('frame')) || document.body;
}

/**
 * 화면 좌표의 사각형을 90° 돌린 프레임 안의 좌표로 바꾼다.
 * 프레임은 left: 100vw에서 rotate(90deg)이므로 프레임 점 (x, y)는 화면의 (W − y, x)에 그려진다.
 * @param {{left: number, top: number, right: number, bottom: number}} r getBoundingClientRect 결과
 * @param {number} viewportWidth 화면 폭 W
 */
export function toFrameRect(r, viewportWidth) {
  const left = r.top;
  const top = viewportWidth - r.right;
  const width = r.bottom - r.top;
  const height = r.right - r.left;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * 회전 여부를 다시 계산한다. 세로로 든 휴대 기기이고 앱 실행 중이 아니면 돌린다.
 * @param {{running: boolean}} o
 */
export function updateRotation({ running }) {
  const portrait = matchMedia('(orientation: portrait)').matches;
  document.documentElement.classList.toggle(ROTATED_CLASS, portrait && isHandheld() && !running);
}

/**
 * 화면 방향 고정을 요청한다. 설치한 Android PWA·전체화면에서만 되고, 나머지(iOS, 브라우저 탭)는 조용히 실패한다.
 * 플레이어는 'landscape', QR 전송은 'portrait', 앱 실행은 'any' (manifest가 landscape라 unlock()으로는 풀리지 않는다)
 * @param {'landscape' | 'portrait' | 'any'} kind
 */
export function lockOrientation(kind) {
  try {
    screen.orientation?.lock?.(kind)?.catch?.(() => {});
  } catch {}
}
