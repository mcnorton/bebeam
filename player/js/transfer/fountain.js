// LT(Luby Transform) fountain code (TASK T7.2, TRANSPORT §5)
//   심볼 하나 = 원본 블록 몇 개의 XOR. 어떤 블록들인지는 (seed, id)로 정해지므로 송신자와 수신자가 따로 계산한다.
//   systematic(처음 k개를 원본 그대로)은 쓰지 않는다: 손실이 있으면 수리 심볼이 이미 받은 블록만 섞여 낭비가 크다
//   (시뮬레이션 손실 10%에서 1.42×, 순수 LT는 손실과 무관하게 약 1.05×. docs/research/R4-fountain.md).
//   수신: peeling(이웃이 하나만 남은 식부터 풀기)으로 풀고, 막히면 남은 미지수가 적을 때만 GF(2) 가우스 소거.
// DOM 없음. 블록 데이터는 하나의 Uint8Array(k × size)에 둔다.

/** mulberry32 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** (seed, id) → 32비트 시드. 가까운 id끼리도 서로 다른 난수열이 나오게 섞는다 */
function mix(seed, id) {
  let h = (seed ^ Math.imul(id >>> 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export const SOLITON_C = 0.03;
/**
 * 최대 차수. 차수는 (seed, id)로 정해지고 둘 다 송신자가 고르므로, 상한이 없으면 악의적 송신자가 차수가 k에 가까운 id만
 * 골라 수신자 메인 스레드를 멈출 수 있다(보안 검토 T7.8). 512는 k = 50000까지 오버헤드에 영향이 없었다(R4 §1.4)
 */
export const MAX_DEGREE = 512;
export const SOLITON_DELTA = 0.5;

const cdfCache = new Map();

/** robust soliton 분포의 누적 분포. cdf[d-1] = P(degree ≤ d) */
export function solitonCdf(k, c = SOLITON_C, delta = SOLITON_DELTA) {
  const key = `${k}/${c}/${delta}`;
  let cdf = cdfCache.get(key);
  if (cdf) return cdf;
  cdf = new Float64Array(k);
  if (k === 1) {
    cdf[0] = 1;
  } else {
    const R = c * Math.log(k / delta) * Math.sqrt(k);
    const pivot = Math.min(k, Math.max(1, Math.floor(k / R)));
    let sum = 0;
    for (let d = 1; d <= k; d++) {
      let p = d === 1 ? 1 / k : 1 / (d * (d - 1));
      if (d < pivot) p += R / (d * k);
      else if (d === pivot) p += Math.max(0, (R * Math.log(R / delta)) / k); // 작은 k에서 R < δ이면 음수가 된다
      sum += p;
      cdf[d - 1] = sum;
    }
    for (let d = 0; d < k; d++) cdf[d] /= sum;
  }
  if (cdfCache.size >= 2) cdfCache.clear(); // k가 크면 항목 하나가 수십 MB다
  cdfCache.set(key, cdf);
  return cdf;
}

/**
 * 심볼 id가 XOR하는 원본 블록 번호들 (서로 다름, 오름차순 아님).
 * @returns {Int32Array}
 */
export function neighbors(id, k, seed) {
  const random = seededRandom(mix(seed, id));
  const cdf = solitonCdf(k);
  const u = random();
  let lo = 0, hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  const degree = Math.min(lo + 1, MAX_DEGREE);
  const out = new Int32Array(degree);
  if (degree === k) {
    for (let i = 0; i < k; i++) out[i] = i;
    return out;
  }
  const seen = new Set();
  for (let n = 0; n < degree; ) {
    const b = Math.floor(random() * k);
    if (seen.has(b)) continue;
    seen.add(b);
    out[n++] = b;
  }
  return out;
}

function xorInto(dst, src, srcOffset, size) {
  for (let i = 0; i < size; i++) dst[i] ^= src[srcOffset + i];
}

export class LtEncoder {
  /**
   * @param {Uint8Array} data 보낼 바이트 (마지막 블록은 0으로 채운 것으로 본다)
   * @param {{size: number, seed: number}} o
   */
  constructor(data, { size, seed }) {
    this.size = size;
    this.seed = seed >>> 0;
    this.k = Math.max(1, Math.ceil(data.length / size));
    this.blocks = new Uint8Array(this.k * size);
    this.blocks.set(data);
  }

  /** @returns {Uint8Array} 길이 size */
  symbol(id) {
    const { size, k } = this;
    const out = new Uint8Array(size);
    for (const b of neighbors(id, k, this.seed)) xorInto(out, this.blocks, b * size, size);
    return out;
  }
}

/** 가우스 소거를 시도하는 남은 미지수 상한 (n² 비트 행렬, n²·size 바이트 XOR) */
export const GE_MAX_UNKNOWNS = 1000;
/** 소거에 쓰는 식은 최근 것 미지수 + GE_SLACK개까지 (식이 끝없이 쌓여도 비용이 늘지 않게) */
const GE_SLACK = 64;

export class LtDecoder {
  #known;
  #data;
  #adj; // 블록 → 그 블록을 아직 포함한 식들
  #pending = new Set(); // 풀리지 않은 식 (이웃 2개 이상)
  #seen = new Set(); // 받은 심볼 id
  #queue = [];
  #sinceGe = 0;
  #geWait = 0; // 소거가 실패하면 다음 시도까지 기다릴 심볼 수를 두 배로 (backoff)

  /** @param {{k: number, size: number, seed: number}} o */
  constructor({ k, size, seed }) {
    this.k = k;
    this.size = size;
    this.seed = seed >>> 0;
    this.decoded = 0;
    this.received = 0; // 중복 없이 받은 심볼 수
    this.#known = new Uint8Array(k);
    this.#data = new Uint8Array(k * size);
    this.#adj = new Array(k);
  }

  get done() {
    return this.decoded === this.k;
  }

  /** 아직 모르는 블록이 있는지 (진행 표시용) */
  isKnown(block) {
    return this.#known[block] === 1;
  }

  /**
   * 심볼 하나를 넣는다. 새로 풀린 블록이 있으면 true.
   * @param {number} id
   * @param {Uint8Array} bytes 길이 size
   */
  add(id, bytes) {
    if (this.done || bytes.length !== this.size) return false;
    const before = this.decoded;
    const { k, size } = this;
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    this.received++;
    const eq = { nbrs: neighbors(id, k, this.seed), bytes: bytes.slice(), count: 0, xorIdx: 0 };
    for (const b of eq.nbrs) {
      if (this.#known[b]) xorInto(eq.bytes, this.#data, b * size, size);
      else {
        eq.count++;
        eq.xorIdx ^= b;
      }
    }
    if (eq.count === 1) this.#resolve(eq.xorIdx, eq.bytes);
    else if (eq.count > 1) {
      for (const b of eq.nbrs) if (!this.#known[b]) (this.#adj[b] ??= []).push(eq);
      this.#pending.add(eq);
    }
    this.#drain();
    if (!this.done) this.#maybeEliminate();
    return this.decoded > before;
  }

  /** @param {number} length 원래 데이터 길이 (마지막 블록의 채움을 잘라낸다) */
  result(length) {
    if (!this.done) return null;
    return this.#data.slice(0, length);
  }

  #resolve(block, bytes) {
    this.#queue.push(block, bytes);
  }

  #drain() {
    const q = this.#queue;
    const { size } = this;
    while (q.length) {
      const bytes = q.pop();
      const block = q.pop();
      if (this.#known[block]) continue;
      this.#known[block] = 1;
      this.#data.set(bytes, block * size);
      this.decoded++;
      const list = this.#adj[block];
      this.#adj[block] = undefined;
      if (!list) continue;
      for (const eq of list) {
        if (eq.count < 2) continue; // 이미 풀린 식
        xorInto(eq.bytes, bytes, 0, size);
        eq.count--;
        eq.xorIdx ^= block;
        if (eq.count === 1) {
          this.#pending.delete(eq);
          eq.count = 0;
          q.push(eq.xorIdx, eq.bytes);
        }
      }
    }
  }

  /**
   * peeling이 막혔을 때: 남은 미지수가 적고 식이 충분하면 GF(2) 가우스 소거로 한 번에 푼다.
   * 비싸므로 새 심볼이 어느 정도 쌓였을 때만 시도한다.
   */
  #maybeEliminate() {
    const unknowns = this.k - this.decoded;
    const eqs = this.#pending.size;
    this.#sinceGe++;
    if (unknowns > GE_MAX_UNKNOWNS || eqs < unknowns) return;
    if (this.#sinceGe < Math.max(4, unknowns >> 4, this.#geWait)) return;
    this.#sinceGe = 0;
    if (!this.#eliminate()) this.#geWait = Math.min(Math.max(8, this.#geWait * 2), 4096);
  }

  /** 모든 미지수가 아직 살아 있는 식에 한 번이라도 나오는지 (아니면 소거는 반드시 실패한다) */
  #covered() {
    for (let b = 0; b < this.k; b++) {
      if (this.#known[b]) continue;
      if (!this.#adj[b]?.some((eq) => eq.count >= 2)) return false;
    }
    return true;
  }

  /** @returns {boolean} 풀었으면 true */
  #eliminate() {
    if (!this.#covered()) return false;
    const { size } = this;
    const col = new Map(); // 블록 → 열 번호
    for (let b = 0; b < this.k; b++) if (!this.#known[b]) col.set(b, col.size);
    const n = col.size;
    const words = (n + 31) >>> 5;
    const rows = [];
    const eqs = [...this.#pending].slice(-(n + GE_SLACK));
    for (const eq of eqs) {
      const bits = new Uint32Array(words);
      for (const b of eq.nbrs) {
        const c = col.get(b);
        if (c !== undefined) bits[c >>> 5] |= 1 << (c & 31);
      }
      rows.push({ bits, bytes: eq.bytes.slice() });
    }
    // 앞으로 소거 (열마다 피벗)
    const pivotOf = new Array(n);
    let r = 0;
    for (let c = 0; c < n && r < rows.length; c++) {
      const w = c >>> 5, m = 1 << (c & 31);
      let p = r;
      while (p < rows.length && !(rows[p].bits[w] & m)) p++;
      if (p === rows.length) return false; // 계수가 모자란다. 심볼을 더 기다린다
      [rows[r], rows[p]] = [rows[p], rows[r]];
      const pr = rows[r];
      for (let i = 0; i < rows.length; i++) {
        if (i === r || !(rows[i].bits[w] & m)) continue;
        const ri = rows[i];
        for (let j = 0; j < words; j++) ri.bits[j] ^= pr.bits[j];
        xorInto(ri.bytes, pr.bytes, 0, size);
      }
      pivotOf[c] = r++;
    }
    if (r < n) return false;
    const blockOf = [...col.keys()];
    for (let c = 0; c < n; c++) this.#resolve(blockOf[c], rows[pivotOf[c]].bytes);
    this.#pending.clear();
    this.#adj = new Array(this.k);
    this.#drain();
    return true;
  }
}
