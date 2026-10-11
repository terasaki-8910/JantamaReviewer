import type { Grade } from '@jantama/engine';

import type { Rating, SelfRatingValue } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';
import { DISPLAY_GRADES, GradeBadge } from './GradeBadge';
import type { HandRow, HandTableData } from './handRows';
import { Icon } from './Icon';
import type { MarkChip } from './markChips';
import { MenuSelect } from './MenuSelect';

/**
 * 局の評価の表（F10）。1 行 = 取り込んだ結果の 1 局: 局・結果・点・自分の〇△✕・AI 基準・MAKA。最後に半荘全体の行。
 * - 自分: ふだんは形だけ。押すと、〇・△・✕・なしのメニュー。付けていない局は、点線の「付ける」。
 *   AI 基準と大きく食い違う局には、小さな旗（規則はエンジンの `disagreesWithGrade`）
 * - AI 基準: 局の Rating から当てはめた段階と、その Rating。候補・確率・順位は出さない（SPEC F3）
 * - MAKA: 任意。入れていなければ点線の「入力」。押すと、14 段階（と「なし」）のメニュー
 * - 迷い（札が 1 つでもあるときだけ出る列。R11-9、U-27）: その局の迷いを、「迷い1 5巡目 打6s」の札で並べる。札を押すと、その迷いのカードへ移る（`onJumpToMark`）。
 *   選んだ（チェックつき）・推定（枠だけ）・巡目は未定（点線）は、形でも見分けられる。幅が狭いときは、局ごとのかたまりに「迷い」の行が付く
 * 付け直す・入れるたびに保存し、取り消せる（`onSelfRating`・`onMaka`）。
 */

/** 迷いの札の説明（札が出ているときだけ、表の下に出す）。 */
export const MARK_CHIPS_HINT =
  '迷いの札を押すと、その迷いのカードへ移ります。点線の札は巡目が未定、チェックの付いた札は選んだもの、ほかは推定です。';

const SELF_OPTIONS: ReadonlyArray<{ value: SelfRatingValue; label: string }> = [
  { value: 'good', label: RATING_GLYPH.good },
  { value: 'fair', label: RATING_GLYPH.fair },
  { value: 'bad', label: RATING_GLYPH.bad },
  { value: 'none', label: 'なし' },
];

interface HandTableProps {
  table: HandTableData;
  /** 自分の〇△✕を付け直した（`none` は「評価なし」）。 */
  onSelfRating: (row: HandRow, value: SelfRatingValue) => void;
  /** MAKA の評価を入れた・消した（`row` が無いときは半荘全体）。`undefined` は、消した。 */
  onMaka: (row: HandRow | null, grade: Grade | undefined) => void;
  /** 局ごとの迷いの札（局の添字 → 札）。渡さない・札が 1 つも無いときは、「迷い」の列を出さない。 */
  chips?: ReadonlyMap<number, readonly MarkChip[]>;
  /** 札を押した（迷いの記録の番号。そのカードへ移る）。 */
  onJumpToMark?: (markId: number) => void;
}

export function HandTable({ table, onSelfRating, onMaka, chips, onJumpToMark }: HandTableProps) {
  const { rows, hanchan } = table;
  const withChips = chips !== undefined && chips.size > 0;
  return (
    <>
      <div className={withChips ? 'tbl-wrap with-marks' : 'tbl-wrap'}>
        <table className="tbl">
          <caption className="sr-only">局の評価</caption>
          <thead>
            <tr>
              <th scope="col">局</th>
              <th scope="col">結果</th>
              <th scope="col" className="num">
                点
              </th>
              <th scope="col">自分</th>
              <th scope="col">AI 基準</th>
              <th scope="col">MAKA</th>
              {withChips && <th scope="col">迷い</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.resultText}</td>
                <td className="num">{row.deltaText}</td>
                <td data-label="自分">
                  <SelfCell row={row} onSelfRating={onSelfRating} />
                </td>
                <td data-label="AI 基準">
                  <AiCell grade={row.grade} ratingText={row.ratingText} />
                </td>
                <td data-label="MAKA">
                  <MakaCell label={row.label} value={row.maka} onChange={(grade) => onMaka(row, grade)} />
                </td>
                {withChips && (
                  <td className="marks-cell" data-label="迷い">
                    <KyokuChips chips={chips.get(row.position) ?? []} onJump={onJumpToMark} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">半荘全体</th>
              <td />
              <td />
              <td />
              <td data-label="AI 基準">
                <AiCell grade={hanchan.grade} ratingText={hanchan.ratingText} />
              </td>
              <td data-label="MAKA">
                <MakaCell label="半荘全体" value={hanchan.maka} onChange={(grade) => onMaka(null, grade)} />
              </td>
              {withChips && <td className="marks-cell" />}
            </tr>
          </tfoot>
        </table>
      </div>
      {table.flaggedCount > 0 && (
        <p className="tbl-note">
          <span className="flag" aria-hidden="true">
            <Icon name="flag" />
          </span>
          結果が悪かった局を低く付けていないか
        </p>
      )}
      {withChips && <p className="tbl-note marks-note">{MARK_CHIPS_HINT}</p>}
      {table.unplacedRatings > 0 && (
        <p className="tbl-note">
          ウィジェットで付けた評価のうち、{table.unplacedRatings}件は、どの局にも当てはまりませんでした
        </p>
      )}
    </>
  );
}

/** 1 つの局の迷いの札（無ければ、何も出さない）。 */
function KyokuChips({ chips, onJump }: { chips: readonly MarkChip[]; onJump: HandTableProps['onJumpToMark'] }) {
  if (chips.length === 0) return null;
  return (
    <span className="mk-chips">
      {chips.map((chip) => (
        <button
          key={chip.markId}
          type="button"
          className="mk-chip"
          data-kind={chip.kind}
          aria-label={chip.label}
          onClick={() => onJump?.(chip.markId)}
        >
          {chip.kind === 'chosen' && <Icon name="check" className="mk-ck" />}
          <b>{chip.head}</b> <span>{chip.what}</span>
        </button>
      ))}
    </span>
  );
}

/** 自分の評価のボタンの名前。見える文字（点線の「付ける」）を、名前の一部にする（ラベルの文字と名前をそろえる）。 */
function selfButtonLabel(label: string, value: Rating | null): string {
  return value === null ? `${label}の自分の評価を付ける` : `${label}の自分の評価（${RATING_GLYPH[value]}）`;
}

/** MAKA のボタンの名前。見える文字（点線の「入力」）を、名前の一部にする。 */
function makaButtonLabel(label: string, value: Grade | null): string {
  return value === null ? `${label}の MAKA を入力` : `${label}の MAKA ${value}`;
}

function SelfCell({ row, onSelfRating }: { row: HandRow; onSelfRating: HandTableProps['onSelfRating'] }) {
  const current: SelfRatingValue = row.self ?? 'none';
  return (
    <span className="self">
      <MenuSelect
        className={row.self === null ? 'ghost' : 'self-btn'}
        label={selfButtonLabel(row.label, row.self)}
        menuLabel={`${row.label}の自分の評価`}
        items={SELF_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          icon: option.value === 'none' ? undefined : <RatingShape rating={option.value} />,
          hideLabel: option.value !== 'none',
          checked: option.value === current,
          onSelect: () => onSelfRating(row, option.value),
        }))}
      >
        {row.self === null ? (
          '付ける'
        ) : (
          <span className="gl">
            <RatingShape rating={row.self} />
          </span>
        )}
      </MenuSelect>
      {row.flagged && (
        <span className="flag" role="img" aria-label="AI 基準と大きく違います">
          <Icon name="flag" />
        </span>
      )}
    </span>
  );
}

function AiCell({ grade, ratingText: rating }: { grade: Grade | null; ratingText: string | null }) {
  if (grade === null) return <span className="quiet">判断なし</span>;
  return (
    <span className="ai">
      <GradeBadge grade={grade} />
      {rating !== null && <span className="mono">{rating}</span>}
    </span>
  );
}

function MakaCell({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Grade | null;
  onChange: (grade: Grade | undefined) => void;
}) {
  return (
    <MenuSelect
      className={value === null ? 'ghost' : 'sel-btn maka-btn'}
      label={makaButtonLabel(label, value)}
      menuLabel={`${label}の MAKA`}
      items={[
        { key: 'none', label: 'なし', checked: value === null, onSelect: () => onChange(undefined) },
        ...DISPLAY_GRADES.map((grade) => ({
          key: grade,
          label: grade,
          checked: grade === value,
          onSelect: () => onChange(grade),
        })),
      ]}
    >
      {value === null ? (
        '入力'
      ) : (
        <>
          <span className="sel-v">{value}</span>
          <Icon name="chevronDown" className="sel-ic" />
        </>
      )}
    </MenuSelect>
  );
}
