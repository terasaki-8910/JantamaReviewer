/**
 * 迷いの画像の大きな表示（`Lightbox`）に渡す、画像 1 枚分の項目。画像の下に出す文は、迷いのカードの 2 行目と同じ内容
 * （「迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い」）。半荘のページと、出題・通して見る画面の「迷いのスクショ」の欄が、同じ文を出す。
 */
import { convertFileSrc } from '@tauri-apps/api/core';

import type { MarkRecord } from '../api/types';
import { formatClock } from './format';
import type { ViewerItem } from './Lightbox';
import { markCaptionParts, type ResolvedMark } from './markCards';

/** 画像のある迷いの項目。撮れなかった迷い（画像なし）は null。`resolved` は結びつけの状態（取り込み前は null）。 */
export function viewerItemOf(mark: MarkRecord, number: number, resolved: ResolvedMark | null): ViewerItem | null {
  if (!mark.screenshot_path) return null;
  const parts = [`迷い${number}`, ...markCaptionParts(resolved)];
  return {
    src: convertFileSrc(mark.screenshot_path),
    alt: `迷い${number}のスクリーンショット`,
    caption: parts.join(' · '),
    time: formatClock(mark.t_ms),
  };
}
