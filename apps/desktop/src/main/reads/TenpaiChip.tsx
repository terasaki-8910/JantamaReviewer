/**
 * 他家の席の、聴牌の確率の札（F23）。卓の中央の箱の、他家の点数の下に「聴牌 62%」を出す。
 * 中央の箱が狭いときは（quiz.css の cbox の幅）、折り返さずに「聴牌」の文字を隠し、数だけ残す。名前（読み上げ）は、いつも全部。
 * 答える前は DOM に無い（U-1）ので、`data-ai` を付ける。
 */
import { chipText, percentOf } from './explain';

export function TenpaiChip({ probability }: { probability: number }) {
  return (
    <span className="rd-tp" role="img" aria-label={chipText(probability)} data-ai="reads-chip">
      <span className="rd-tp-w" aria-hidden="true">
        聴牌{' '}
      </span>
      <span className="rd-tp-n" aria-hidden="true">
        {percentOf(probability)}%
      </span>
    </span>
  );
}
