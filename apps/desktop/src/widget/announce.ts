import type { AppState } from '../api/types';
import { RATING_GLYPH } from '../shared/RatingShape';

/**
 * 記録の状態が変わったとき、読み上げ用の文にする（aria-live）。
 * 変わっていなければ空文字。画面の見た目と同じ内容を、音声でも知らせるためのもの。
 */
export function describeChange(prev: AppState | null, next: AppState): string {
  if (!prev) return '';
  if (prev.session_id !== next.session_id && next.session_id !== null) {
    return '新しい半荘を始めました';
  }
  if (next.ratings.length > prev.ratings.length) {
    const last = next.ratings[next.ratings.length - 1];
    return last ? `${next.ratings.length}局目を${RATING_GLYPH[last]}で記録` : '';
  }
  if (next.mark_count > prev.mark_count) {
    return `迷いの印を追加。合計${next.mark_count}`;
  }
  if (next.ratings.length < prev.ratings.length) {
    return `${prev.ratings.length}局目の評価を取り消し`;
  }
  if (next.mark_count < prev.mark_count) {
    return `迷いの印を取り消し。合計${next.mark_count}`;
  }
  return '';
}
