/**
 * 「読み」の切り替え（F23）と、読みの説明のアイコン。
 * 切り替えは、通して見る画面の操作の段にある「細かいミスだけ」の切り替えと同じ見た目（`btn sm fm-toggle`。入のときはチェックの印と accent の枠・文字）で、
 * 入切は `aria-pressed` で読み上げられる。割り当てたキーは、名前の説明（title）に出す。
 * 出題・解き直しでは、答え合わせのあとだけ、卓の上の 1 行（`BoardTools`）に置く。答える前は、DOM に無い（U-1）。
 */
import { Icon } from '../Icon';
import { InfoTip } from '../InfoTip';
import { formatChord } from '../replay/keys';

/** 説明のアイコンの文（SPEC F23）。 */
export const READS_HINT =
  '読み: 他家がその牌を待っている確率（3 人のどれか）。ロンできるか（役・フリテン）は含みません。天鳳の鳳凰卓で学習したモデル（hhim8826/mortal3-b40c192）の推定で、外れることもあります。';

/** 切り替えの名前の説明。 */
const TOGGLE_TITLE = '入れると、手牌の下に牌ごとの待たれる確率、他家の席に聴牌の確率を出します';

interface ReadsToggleProps {
  on: boolean;
  onToggle: () => void;
  /** 「読みの入切」に割り当てたキー（無ければ null）。 */
  keyChord: string | null;
}

export function ReadsToggle({ on, onToggle, keyChord }: ReadsToggleProps) {
  const title = keyChord === null ? TOGGLE_TITLE : `${TOGGLE_TITLE}（${formatChord(keyChord)}）`;
  return (
    <span className="reads-group">
      <button type="button" className={`btn sm fm-toggle${on ? ' on' : ''}`} data-reads="toggle" aria-pressed={on} title={title} onClick={onToggle}>
        {on && <Icon name="check" />}
        読み
      </button>
      <InfoTip label="読みの説明">{READS_HINT}</InfoTip>
    </span>
  );
}
