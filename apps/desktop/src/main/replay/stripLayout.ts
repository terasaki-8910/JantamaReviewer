/**
 * 位置の帯（F12）の印（迷いは帯の上の丸、不一致は下のひし形）を置く x 座標。純粋な関数。
 *
 * 印は、手の位置（0〜1 の割合）に置く。近すぎるものは、押せる大きさ（`min`。24px）が重ならないよう右へずらし、
 * 右の端からはみ出すなら左へ詰める。数が多くて並びきらないときは、重なりが最も少ない等間隔にする。
 */
export function layoutPins(ratios: readonly number[], width: number, min = 24): number[] {
  const count = ratios.length;
  if (count === 0 || width <= 0) return ratios.map(() => min / 2);
  const half = min / 2;
  // 並びきらないときの間隔（左右の端の半分ずつを除いた幅を、等分する）
  const spacing = count > 1 ? Math.min(min, (width - min) / (count - 1)) : min;
  const xs = ratios.map((ratio) => Math.max(half, ratio * width));
  for (let i = 1; i < count; i++) xs[i] = Math.max(xs[i] as number, (xs[i - 1] as number) + spacing);
  const over = (xs[count - 1] as number) - (width - half);
  if (over > 0) {
    xs[count - 1] = (xs[count - 1] as number) - over;
    for (let i = count - 2; i >= 0; i--) xs[i] = Math.min(xs[i] as number, (xs[i + 1] as number) - spacing);
  }
  return xs.map((x) => Math.max(half, x));
}

/** 帯の上の押した位置（`x`・帯の左端 `left`・幅 `width`）を、手の通し番号（0 から `total - 1`）にする。 */
export function stepAtPoint(x: number, left: number, width: number, total: number): number {
  if (width <= 0 || total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (x - left) / width));
  return Math.round(ratio * (total - 1));
}
