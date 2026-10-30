/**
 * 中央の箱が狭くて席の札が入らないときの、卓の上の 1 行（F23）。「聴牌 下家 5% · 対面 17% · 上家（リーチ） 100%」。
 * 卓の上の行の高さは変えず、折り返さない。答える前は DOM に無い（U-1）ので、`data-ai` を付ける。
 */
import { Fragment } from 'react';

import type { ReadsMoment } from '../../api/reads';
import { tenpaiLineItems } from './explain';

export function TenpaiLine({ moment }: { moment: ReadsMoment }) {
  return (
    <p className="rd-line" data-ai="reads-line">
      <span>聴牌</span>
      {tenpaiLineItems(moment).map((item, index) => (
        <Fragment key={item.seat}>
          {index > 0 && (
            <span className="rd-line-sep" aria-hidden="true">
              ·
            </span>
          )}
          <span>
            {item.name}
            {item.riichi && <span className="rd-line-rch">（リーチ）</span>}
          </span>
          <span className="rd-line-n">{item.percent}%</span>
        </Fragment>
      ))}
    </p>
  );
}
