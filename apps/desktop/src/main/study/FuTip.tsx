/**
 * 符の数（「40符」）と、そこにマウスを乗せる・キーボードで選ぶと重なって出る、符の内訳（F14、E-38、U-34。R15-3 の 8）。
 * 重なりの出し方・置き方・閉じ方は、説明のアイコン（InfoTip）と同じ（`Tip`）。見た目は styles/waits.css（承認済みの見本の部品）。
 *
 * 内訳が無いとき（符が出ない和了・majiang-core の符と数え方が合わないとき）は、符の数だけ書く。
 */
import type { WaitLine } from '@jantama/engine';
import { Fragment } from 'react';

import { Tip } from '../InfoTip';
import { tileName } from './tiles';

interface FuTipProps {
  line: WaitLine;
  /** 読み上げ用の、どの計算の符か（例: 「6索 ダマ ロン」）。 */
  context: string;
}

export function FuTip({ line, context }: FuTipProps) {
  const { fu, fuBreakdown: breakdown } = line;
  if (fu === null) return null;
  if (breakdown === null) return <>{fu}符</>;
  const sum =
    breakdown.total === breakdown.rounded ? (
      <span className="fp-sum">
        <span>合計</span> <span className="n">{breakdown.rounded}符</span>
      </span>
    ) : (
      <span className="fp-sum">
        <span>
          合計 <span className="n">{breakdown.total}</span> を 10 符単位に切り上げ
        </span>{' '}
        <span className="n">{breakdown.rounded}符</span>
      </span>
    );
  return (
    <Tip
      wrapperClassName="wt-fu-wrap"
      triggerClassName="wt-fu"
      triggerLabel={`${fu}符の内訳（${context}）`}
      triggerContent={`${fu}符`}
      popClassName="wt-fu-pop"
    >
      <span className="fp-t">{fu}符の内訳</span>{' '}
      {breakdown.items.map((item) => (
        <Fragment key={item.label}>
          <span className="fp-r">
            <span>{item.label}</span> <span className="n">{item.fu}</span>
          </span>{' '}
        </Fragment>
      ))}
      {sum}
      {' '}
      {breakdown.note !== null && <span className="fp-n">{breakdown.note}</span>}
    </Tip>
  );
}

/** 待ち牌の呼び名（読み上げ用の文脈に使う）。 */
export function waitContext(tile: string, how: string): string {
  return `${tileName(tile)} ${how}`;
}
