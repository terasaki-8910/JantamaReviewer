/**
 * 単調な当てはめ（アイソトニック回帰）。scikit-learn の IsotonicRegression(out_of_bounds='clip') と
 * 同じ手順・同じ計算の順序で作ってあり、同じデータなら同じ値になる（E-13）。
 *
 * 手順:
 * 1. 重みが 0 以下の点を除き、点数 x の昇順（同じなら y の昇順）に並べる
 * 2. 同じ x の点を、重みつきの平均の y 1 点にまとめる
 * 3. 隣り合う点をまとめて平均する方法（pool adjacent violators）で、y が単調に増えるようにする
 * 4. 前後と同じ y の点（両端以外）を、しきい値から取り除く
 * 5. 予測は、x を範囲に収めて（clip）から、しきい値の間を直線で補間する（numpy.interp と同じ）
 */

export interface IsotonicModel {
  /** 補間に使う点数のしきい値（昇順）。 */
  readonly xThresholds: readonly number[];
  /** しきい値ごとの当てはめ値（単調に増える）。 */
  readonly yThresholds: readonly number[];
  /** 学習データの点数の最小・最大（これより外は端の値に収める）。 */
  readonly xMin: number;
  readonly xMax: number;
}

/** 同じ点数とみなす差（numpy.finfo(float64).resolution）。 */
const SAME_X_EPS = 1e-15;

/** 隣り合う点をまとめて単調にする。y と w は書き換える（sklearn の _inplace_contiguous_isotonic_regression）。 */
function poolAdjacentViolators(y: Float64Array, w: Float64Array): void {
  const n = y.length;
  // target: ブロックの先頭と末尾の対応。ブロック [i..j] が有効なら target[i] = j、target[j] = i。
  const target = new Int32Array(n);
  for (let i = 0; i < n; i++) target[i] = i;

  let i = 0;
  while (i < n) {
    let k = (target[i] as number) + 1;
    if (k === n) break;
    if ((y[i] as number) < (y[k] as number)) {
      i = k;
      continue;
    }
    let sumWy = (w[i] as number) * (y[i] as number);
    let sumW = w[i] as number;
    for (;;) {
      // 減っている部分をまとめる
      const prevY = y[k] as number;
      sumWy += (w[k] as number) * prevY;
      sumW += w[k] as number;
      k = (target[k] as number) + 1;
      if (k === n || prevY < (y[k] as number)) {
        y[i] = sumWy / sumW;
        w[i] = sumW;
        target[i] = k - 1;
        target[k - 1] = i;
        if (i > 0) i = target[i - 1] as number;
        break;
      }
    }
  }

  // 各ブロックの先頭の値を、ブロック全体に広げる
  i = 0;
  while (i < n) {
    const k = (target[i] as number) + 1;
    y.fill(y[i] as number, i + 1, k);
    i = k;
  }
}

/**
 * 点 (x, y) に単調に増える当てはめをする。weights を省くと全部 1。
 * 点が1つも残らない（空・重みがすべて 0 以下）ときは RangeError。
 */
export function fitIsotonic(x: readonly number[], y: readonly number[], weights?: readonly number[]): IsotonicModel {
  if (x.length !== y.length || (weights !== undefined && weights.length !== x.length)) {
    throw new RangeError('x・y・weights の長さが違います');
  }
  const order: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const w = weights ? (weights[i] as number) : 1;
    if (w > 0) order.push(i);
  }
  if (order.length === 0) throw new RangeError('当てはめるデータがありません');
  order.sort((a, b) => (x[a] as number) - (x[b] as number) || (y[a] as number) - (y[b] as number) || a - b);

  // 同じ点数の点を、重みつきの平均にまとめる
  const ux: number[] = [];
  const uy: number[] = [];
  const uw: number[] = [];
  const first = order[0] as number;
  let currentX = x[first] as number;
  let currentY = 0;
  let currentW = 0;
  for (const i of order) {
    const xi = x[i] as number;
    const wi = weights ? (weights[i] as number) : 1;
    const yi = y[i] as number;
    if (xi - currentX >= SAME_X_EPS) {
      ux.push(currentX);
      uw.push(currentW);
      uy.push(currentY / currentW);
      currentX = xi;
      currentW = wi;
      currentY = yi * wi;
    } else {
      currentW += wi;
      currentY += yi * wi;
    }
  }
  ux.push(currentX);
  uw.push(currentW);
  uy.push(currentY / currentW);

  const fitted = Float64Array.from(uy);
  poolAdjacentViolators(fitted, Float64Array.from(uw));

  const m = ux.length;
  const xThresholds: number[] = [];
  const yThresholds: number[] = [];
  for (let i = 0; i < m; i++) {
    const keep = i === 0 || i === m - 1 || fitted[i] !== fitted[i - 1] || fitted[i] !== fitted[i + 1];
    if (keep) {
      xThresholds.push(ux[i] as number);
      yThresholds.push(fitted[i] as number);
    }
  }
  return { xThresholds, yThresholds, xMin: ux[0] as number, xMax: ux[m - 1] as number };
}

/**
 * 点数 t の当てはめ値。t は学習データの範囲に収めてから、しきい値の間を直線で補間する。
 * 補間は numpy.interp と同じ（しきい値ちょうどならその値、間なら slope * (t - x_lo) + y_lo）。
 */
export function predictIsotonic(model: IsotonicModel, t: number): number {
  const xs = model.xThresholds;
  const ys = model.yThresholds;
  if (Number.isNaN(t)) return Number.NaN;
  const clipped = Math.min(Math.max(t, model.xMin), model.xMax);
  const n = xs.length;
  if (n === 1) return ys[0] as number;

  // clipped 以下で最大のしきい値の添字
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((xs[mid] as number) <= clipped) lo = mid;
    else hi = mid - 1;
  }
  const j = lo;
  if (j === n - 1 || xs[j] === clipped) return ys[j] as number;
  const xLo = xs[j] as number;
  const yLo = ys[j] as number;
  const slope = ((ys[j + 1] as number) - yLo) / ((xs[j + 1] as number) - xLo);
  return slope * (clipped - xLo) + yLo;
}
