// 선 아이콘 (lucide-static 1.56.0의 SVG에서 필요한 것만 옮김. 빌드 도구가 없어 path 데이터를 그대로 둔다)
//   icon('play')는 <svg aria-hidden="true">를 만든다. 색은 currentColor, 크기는 CSS(.icon)로 정한다.
/*
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * ---
 *
 * The following Lucide icons are derived from the Feather project:
 *
 * airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
 *
 * The MIT License (MIT) (for the icons listed above)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const NS = 'http://www.w3.org/2000/svg';

/** 이름 → [태그, 속성][] */
const ICONS = {
  'plus': [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  'scan-qr-code': [['path', { d: 'M17 12v4a1 1 0 0 1-1 1h-4' }], ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }], ['path', { d: 'M17 8V7' }], ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }], ['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }], ['path', { d: 'M7 17h.01' }], ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }], ['rect', { x: '7', y: '7', width: '5', height: '5', rx: '1' }]],
  'play': [['path', { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' }]],
  'send': [['path', { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' }], ['path', { d: 'm21.854 2.147-10.94 10.939' }]],
  'ellipsis': [['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }], ['circle', { cx: '5', cy: '12', r: '1' }]],
  'pencil': [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
  'rotate-ccw': [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
  'trash-2': [['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
  'folder': [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
  'file-archive': [['path', { d: 'M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }], ['path', { d: 'M8 12v-1' }], ['path', { d: 'M8 18v-2' }], ['path', { d: 'M8 7V6' }], ['circle', { cx: '8', cy: '20', r: '2' }]],
  'triangle-alert': [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
  'x': [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  'switch-camera': [['path', { d: 'M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5' }], ['path', { d: 'M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5' }], ['circle', { cx: '12', cy: '12', r: '3' }], ['path', { d: 'm18 22-3-3 3-3' }], ['path', { d: 'm6 2 3 3-3 3' }]],
  'download': [['path', { d: 'M12 15V3' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }]],
  'sun': [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M12 20v2' }], ['path', { d: 'm4.93 4.93 1.41 1.41' }], ['path', { d: 'm17.66 17.66 1.41 1.41' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M20 12h2' }], ['path', { d: 'm6.34 17.66-1.41 1.41' }], ['path', { d: 'm19.07 4.93-1.41 1.41' }]],
  'moon': [['path', { d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' }]],
  'settings': [['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
  'lock': [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
  'circle-x': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  'circle-check': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm16 9-5.5 5.5L8 12' }]],
  'package': [['path', { d: 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z' }], ['path', { d: 'M12 22V12' }], ['polyline', { points: '3.29 7 12 12 20.71 7' }], ['path', { d: 'm7.5 4.27 9 5.15' }]],
  'search': [['path', { d: 'm21 21-4.34-4.34' }], ['circle', { cx: '11', cy: '11', r: '8' }]],
  'inbox': [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  'camera': [['path', { d: 'M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z' }], ['circle', { cx: '12', cy: '13', r: '3' }]],
  'shuffle': [['path', { d: 'm18 14 4 4-4 4' }], ['path', { d: 'm18 2 4 4-4 4' }], ['path', { d: 'M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22' }], ['path', { d: 'M2 6h1.972a4 4 0 0 1 3.6 2.2' }], ['path', { d: 'M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45' }]],
};

/**
 * @param {keyof typeof ICONS} name
 * @param {{class?: string}} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { class: cls = '' } = {}) {
  const parts = ICONS[name];
  if (!parts) throw new Error(`아이콘 없음: ${name}`);
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(k, v);
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** data-icon 속성이 있는 정적 요소(index.html) 앞에 아이콘을 넣는다 */
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (!el.querySelector(':scope > svg.icon')) el.prepend(icon(el.dataset.icon));
  }
}
