/**
 * AI の評価の一覧（右の欄）。候補を確率の高い順に、名札・牌（か答えのボタンの名前）・棒・確率で並べる。
 * 打牌の判断は、手牌の上の棒（`aiBars.ts`・Hand.tsx）で出すので、ここには出さない。鳴き・リーチ・和了・カンの判断が使う
 * （答え合わせのあとの答えの欄と、通して見る画面の、答える場面でない自分の判断の手番の右の欄）。
 * AI の情報なので、`data-ai` を付ける（答える前の画面に無いことを、試験が確かめる。U-1）。
 */
import type { AnswerOption } from '@jantama/engine';

import { isDoraTile } from './dora';
import { formatProbability, type Bar } from './reveal';
import { Tile } from './Tile';

function OptionLabel({ option, dora }: { option: AnswerOption; dora: ReadonlySet<number> | null }) {
  return (
    <>
      <b>{option.label}</b>
      {option.use.map((tile, index) => (
        <Tile key={`${index}${tile}`} tile={tile} dora={isDoraTile(tile, dora)} />
      ))}
    </>
  );
}

interface EvaluationProps {
  bars: readonly Bar[];
  /** 打牌の判断か（牌の列の幅が違う）。 */
  discard: boolean;
  dora: ReadonlySet<number> | null;
}

export function Evaluation({ bars, discard, dora }: EvaluationProps) {
  return (
    <div className="q-sec" data-ai="eval">
      <h2 className="sec-title">AIの評価（Mortal）</h2>
      <ul className={`bars${discard ? '' : ' call'}`}>
        {bars.map((bar) => (
          <li className={bar.kind === 'other' ? 'bar' : `bar ${bar.kind}`} data-ai="candidate" key={bar.key}>
            <span className="btag">{bar.tags.join('・')}</span>
            <span className="lab">
              {bar.tile !== null ? (
                <Tile tile={bar.tile} dora={isDoraTile(bar.tile, dora)} />
              ) : bar.option !== null ? (
                <OptionLabel option={bar.option} dora={dora} />
              ) : null}
            </span>
            <span className="track" aria-hidden="true">
              <span className="fill" style={{ width: `${Math.max(bar.probability * 100, 0.6).toFixed(2)}%` }} />
            </span>
            <span className="v">{formatProbability(bar.probability)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
