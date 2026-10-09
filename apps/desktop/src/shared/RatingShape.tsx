import type { Rating } from '../api/types';

/** 評価の文字（読み上げと文言に使う）。 */
export const RATING_GLYPH: Record<Rating, string> = {
  good: '〇',
  fair: '△',
  bad: '✕',
};

/** 評価の形（承認済みのサンプルと同じ線画）。色と線の太さは CSS で決める。 */
export function RatingShape({ rating }: { rating: Rating }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {rating === 'good' && <circle cx="12" cy="12" r="7.5" />}
      {rating === 'fair' && <path d="M12 5.2 20 18.8H4Z" />}
      {rating === 'bad' && <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />}
    </svg>
  );
}
