/**
 * 窓を見せる時機の合図（N-7）。
 *
 * 窓は隠したまま作られる。最初の絵を描き終えてから `signalWindowReady()` で Rust 側に知らせると、
 * 窓と webview の背景色が、いま描いている背景の色にそろえられてから、窓が見える。
 * 描き終える前の白い面が見えない。
 */
import { api } from '../api/tauri';

/** 画面が描いている背景の色（body の背景。CSS の色の文字列）。色はトークンから来ていて、ここに色の値は無い。 */
export function readPageBackground(doc: Document = document): string {
  const view = doc.defaultView;
  return view ? view.getComputedStyle(doc.body).backgroundColor : '';
}

/**
 * 次の描画が終わるまで待つ。隠れている間は描画の合図（requestAnimationFrame）が来ないことがあるので、
 * 一定の時間がたったら先へ進む。
 */
export function nextPaint(timeoutMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    window.setTimeout(finish, timeoutMs);
    window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
  });
}

let signaled = false;
/** テストで記録を戻したあとに、それ以前の呼び出しの知らせが紛れ込まないようにする世代。 */
let generation = 0;

/** 最初の絵を描き終えたことを Rust 側に知らせる。窓ごとに 1 回だけ（2 回目からは何もしない）。 */
export async function signalWindowReady(): Promise<void> {
  if (signaled) return;
  signaled = true;
  const mine = generation;
  await nextPaint();
  if (mine !== generation) return;
  try {
    await api.windowReady(readPageBackground());
  } catch (error) {
    console.error('窓を見せる知らせを送れませんでした', error);
  }
}

/** テーマが変わったあと（OS の設定の変化を含む）に、窓の背景色を画面の色にそろえさせる。 */
export async function reportBackground(): Promise<void> {
  await nextPaint();
  try {
    await api.setWindowBackground(readPageBackground());
  } catch (error) {
    console.error('窓の背景色を知らせられませんでした', error);
  }
}

/** テスト用: 知らせ済みの記録を戻す。 */
export function resetWindowReadyForTest(): void {
  signaled = false;
  generation += 1;
}
