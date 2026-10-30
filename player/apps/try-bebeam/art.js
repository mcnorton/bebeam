// 픽셀 그림: 글자 지도 한 칸 = 픽셀 한 칸. 시작할 때 SVG data URL로 바꿔 CSS 변수(--art-이름)에 넣는다.
//   '.'은 빈칸, 나머지 글자는 각 그림의 팔레트 색

const ART = {
  // 누를 곳을 가리키는 장갑 손
  glove: {
    colors: { '#': '#3b2414', w: '#f4e6c6', W: '#c9a877', c: '#b8322a' },
    map: [
      '....##......',
      '...#ww#.....',
      '...#ww#.....',
      '...#ww#.....',
      '...#ww###...',
      '...#ww#ww##.',
      '.###ww#ww#w#',
      '#ww#wwwwwwW#',
      '#wwwwwwwwwW#',
      '.#wwwwwwwwW#',
      '..#wwwwwwW#.',
      '...#wwwwW#..',
      '...#cccccc#.',
      '...########.',
    ],
  },
  // 표지 문장: 곰
  bear: {
    colors: { '#': '#3a1f0e', b: '#d9a441', P: '#a8682a', m: '#f3d892' },
    map: [
      '..###......###..',
      '.#bbb#....#bbb#.',
      '.#bPb######bPb#.',
      '.#bbbbbbbbbbbb#.',
      '#bbbbbbbbbbbbbb#',
      '#bbb##bbbb##bbb#',
      '#bbb##bbbb##bbb#',
      '#bbbbbbbbbbbbbb#',
      '#bbbbbmmmmbbbbb#',
      '#bbbbmm##mmbbbb#',
      '.#bbbmmmmmmbbb#.',
      '..#bbbbbbbbbb#..',
      '...##########...',
    ],
  },
  // 다 본 편의 밀랍 봉인
  seal: {
    colors: { r: '#9e1b1b', R: '#e0675a', d: '#6b1010' },
    map: [
      '...rrrrrr...',
      '.rrrrrrrrrr.',
      '.rrRRRRRrrr.',
      'rrrRrrrRrrrr',
      'rrrRrrrRrrrr',
      'rrrRRRRRrrrr',
      'rrrRrrrrRrrr',
      'rrrRrrrrRrrr',
      'rrrRRRRRRrrr',
      '.rrrrrrrrrrd',
      '.rrrrrrrrrd.',
      '...dddddd...',
    ],
  },
  // 여백 낙서
  flask: {
    colors: { '#': '#5a3a20', t: '#2c8a83' },
    map: [
      '...###...',
      '...#.#...',
      '...#.#...',
      '..#...#..',
      '.#.....#.',
      '#.......#',
      '#ttttttt#',
      '#ttttttt#',
      '.#ttttt#.',
      '..#####..',
    ],
  },
  star: {
    colors: { '#': '#5a3a20' },
    map: ['..#..', '.###.', '#####', '.###.', '..#..'],
  },
  fire: {
    colors: { '#': '#5a3a20' },
    map: ['...#...', '..#.#..', '..#.#..', '.#...#.', '.#...#.', '#######'],
  },
  stain: {
    colors: { t: '#8a5a2b' },
    map: [
      '....tttttt....',
      '..tt......tt..',
      '.t..........t.',
      't............t',
      't............t',
      '.t..........t.',
      '..tt.....ttt..',
      '....ttttt.....',
    ],
  },
  // 책갈피의 집 (차례로)
  home: {
    colors: { '#': '#fbefd9' },
    map: [
      '....#....',
      '...###...',
      '..#####..',
      '.#######.',
      '#########',
      '.##...##.',
      '.##.#.##.',
      '.##.#.##.',
      '.#######.',
    ],
  },
  // 주고받기 화살표 (1편 첫 장면 가운데)
  swap: {
    colors: { '#': '#2a9d8f', d: '#1b6b62' },
    map: [
      '...#..........',
      '..##..........',
      '.#############',
      '..##ddddddddd.',
      '...#..........',
      '..............',
      '..........#...',
      '..........##..',
      '#############.',
      '.ddddddddd##..',
      '..........#...',
    ],
  },
  // QR 둘레에서 반짝이는 빛
  sparkle: {
    colors: { s: '#7ff0e4' },
    map: ['.s.', 'sss', '.s.'],
  },
};

/** 글자 지도 → SVG. 같은 색이 이어지는 가로 칸은 rect 하나로 합친다 */
function toSvg({ colors, map }) {
  const w = map[0].length;
  let rects = '';
  map.forEach((row, y) => {
    for (let x = 0; x < w;) {
      const ch = row[x];
      let n = 1;
      while (row[x + n] === ch) n++;
      if (colors[ch]) rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${colors[ch]}"/>`;
      x += n;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${map.length}" shape-rendering="crispEdges">${rects}</svg>`;
}

export function installArt(root = document.documentElement) {
  for (const [name, art] of Object.entries(ART)) {
    root.style.setProperty(`--art-${name}`, `url("data:image/svg+xml,${encodeURIComponent(toSvg(art))}")`);
  }
}
