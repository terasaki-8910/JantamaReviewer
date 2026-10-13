/**
 * 答え合わせの欄のタブの一覧（F14、U-34。R15-2）。
 *
 * 既定のタブ「受け入れ・役」（受け入れ枚数の欄と役の欄）に足すタブを、**1 つずつ**ここに書く。`show` が true の場面だけ、タブが出る
 * （「その場面に関係があるときだけ」）。足すタブが 1 つも無い場面は、タブの並びを出さず、既定の欄だけを、これまでと同じ形で出す。
 * 答え合わせのあとにだけ描く（AI の行動や他家の手牌を含む。U-1）。呼ぶ側（AnswerPanel の Reveal）が、答える前には呼ばない。
 *
 * 他家の手牌（F14、R15-5）は、タブにしない。盤面の他家の手牌を押して開く（R16-7。Board.tsx・OpenHands.tsx）。
 * 足すときは、この一覧に 1 つ書き、中身の元（RevealModel の値）を reveal.ts に足す。
 */
import type { Decision } from '@jantama/engine';
import type { ReactNode } from 'react';

import { DangerPanel } from './DangerPanel';
import type { RevealModel } from './reveal';
import { WaitsPanel } from './WaitsPanel';

/** タブの中身を作るのに要るもの。 */
export interface RevealTabContext {
  decision: Decision;
  model: RevealModel;
  dora: ReadonlySet<number> | null;
}

/** 足すタブ 1 つ。 */
export interface RevealTabEntry {
  id: string;
  label: string;
  /** この場面に関係があるか（無ければ、タブを出さない）。 */
  show: (context: RevealTabContext) => boolean;
  panel: (context: RevealTabContext) => ReactNode;
}

/** 既定のタブの名前。 */
export const DEFAULT_TAB_LABEL = '受け入れ・役';

/** 足すタブ（並べる順）。 */
export const REVEAL_TABS: readonly RevealTabEntry[] = [
  {
    id: 'waits',
    label: '待ちと打点',
    // 聴牌になる行動がある場面（比べる行動が聴牌になる・リーチの判断）
    show: ({ model }) => model.waits !== null,
    panel: ({ model, dora }) => (model.waits === null ? null : <WaitsPanel box={model.waits} dora={dora} />),
  },
  {
    id: 'danger',
    label: '守備',
    // 他家のリーチがある場面か、副露の気配の 1 行を出す他家がいる場面（切れる牌がある判断。R16-6）
    show: ({ model }) => model.danger !== null,
    panel: ({ model, dora }) => (model.danger === null ? null : <DangerPanel box={model.danger} dora={dora} />),
  },
];

/** この場面に出すタブ（足すタブのうち、関係のあるもの）。 */
export function visibleRevealTabs(context: RevealTabContext): RevealTabEntry[] {
  return REVEAL_TABS.filter((tab) => tab.show(context));
}
