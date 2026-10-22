import { useId } from 'react';

import type { AppState, Orientation, Rating, Status } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';
import { useDoubtPress } from './useDoubtPress';

const RATINGS: readonly Rating[] = ['good', 'fair', 'bad'];

const STATUS_LABEL: Record<Status, string> = {
  recording: '記録中',
  idle: '待機中',
  error: 'エラー',
};

export interface WidgetProps {
  orientation: Orientation;
  /** 迷いだけを記録する（設定）。入なら、形によらず 48px 角の「迷い」ボタン 1 つ（F0、W-15）。 */
  doubtOnly: boolean;
  state: AppState;
  /** 押した直後の光り（キーは `doubt`・`rate-good` など）。 */
  flashing: Readonly<Record<string, boolean>>;
  /** 読み上げ用の文（aria-live）。 */
  announcement: string;
  onRate: (rating: Rating) => void;
  onMark: () => void;
  onUndo: () => void;
  /** 迷いだけのボタンを、押したまま動かした（窓を動かし始める）。 */
  onDrag: () => void;
}

function classNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/**
 * ウィジェット（表示だけ）。承認済みのサンプルの縦長・横長をそのまま再現する。
 * 見た目の優先順は 評価 > 迷い > 取り消し。ボタンはすべて 40px 以上。
 * 迷いだけを記録する設定が入のときは、形によらず、窓いっぱいの「迷い」ボタン 1 つ（`DoubtOnlyWidget`）。
 */
export function Widget({
  orientation,
  doubtOnly,
  state,
  flashing,
  announcement,
  onRate,
  onMark,
  onUndo,
  onDrag,
}: WidgetProps) {
  if (doubtOnly) {
    return (
      <DoubtOnlyWidget
        state={state}
        flashing={flashing}
        announcement={announcement}
        onMark={onMark}
        onDrag={onDrag}
      />
    );
  }
  const vertical = orientation === 'vertical';
  const blocked = state.status === 'error';

  const statusRow = (
    <div className="status" title={state.error ?? undefined}>
      <span className={classNames('dot', state.status !== 'recording' && state.status)} aria-hidden="true" />
      {STATUS_LABEL[state.status]}
    </div>
  );
  const nextText = <p className="next">{`次：${state.next_hand}局目`}</p>;

  const ratingButtons = RATINGS.map((rating) => (
    <button
      key={rating}
      type="button"
      className={classNames('w-btn', 'rate-btn', flashing[`rate-${rating}`] && 'flash')}
      aria-label={`${RATING_GLYPH[rating]}（終わった局の評価）`}
      disabled={blocked}
      onClick={() => onRate(rating)}
    >
      <RatingShape rating={rating} />
    </button>
  ));

  const doubtButton = (
    <button
      type="button"
      className={classNames('w-btn', 'doubt', flashing.doubt && 'flash')}
      aria-label={`迷い ${state.mark_count}（押すと印を追加）`}
      disabled={blocked}
      onClick={onMark}
    >
      <span className="lbl">迷い</span>
      <span className="num">{state.mark_count}</span>
    </button>
  );

  const undoButton = (
    <button type="button" className="w-btn undo" disabled={!state.can_undo} onClick={onUndo}>
      取り消し
    </button>
  );

  return (
    <>
      {/* "deep": ボタン以外の場所をつかむと、窓を動かせる。 */}
      <section
        className={classNames('widget', vertical ? 'v' : 'h')}
        aria-label="記録ウィジェット"
        data-tauri-drag-region="deep"
      >
        {vertical ? (
          <>
            {statusRow}
            <div className="rate" role="group" aria-label="終わった局の評価">
              {nextText}
              {ratingButtons}
            </div>
          </>
        ) : (
          <>
            <div className="info">
              {statusRow}
              {nextText}
            </div>
            <div className="rate" role="group" aria-label="終わった局の評価">
              {ratingButtons}
            </div>
          </>
        )}
        {doubtButton}
        {undoButton}
      </section>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}

interface DoubtOnlyWidgetProps {
  state: AppState;
  flashing: Readonly<Record<string, boolean>>;
  announcement: string;
  onMark: () => void;
  onDrag: () => void;
}

/** 状態の読み上げの文（点の意味。エラーのときは、理由も）。 */
function statusText(state: AppState): string {
  return state.error === null ? STATUS_LABEL[state.status] : `${STATUS_LABEL[state.status]}：${state.error}`;
}

/**
 * 迷いだけのウィジェット（F0、W-15）。48px 角の窓いっぱいの「迷い」ボタン 1 つ。
 * 中は「迷い」の文字と、この半荘の迷いの数。記録中かどうかは、右上の小さな点（記録中は塗り、待機中は中抜き、エラーは濃い色）。
 * 〇△✕・「次：N局目」・取り消しのボタンは出さない（取り消しは、右クリックのメニューにある）。
 * 押して動かさずに離すと記録し、押したまま動かすと窓を動かす（`useDoubtPress`）。
 */
function DoubtOnlyWidget({ state, flashing, announcement, onMark, onDrag }: DoubtOnlyWidgetProps) {
  const statusId = useId();
  const blocked = state.status === 'error';
  const press = useDoubtPress({ onPress: onMark, onDrag, disabled: blocked });
  return (
    <>
      <section className="widget sq" aria-label="記録ウィジェット" data-tauri-drag-region="deep">
        <button
          type="button"
          className={classNames('w-btn', 'doubt', 'sq-btn', flashing.doubt && 'flash')}
          aria-label={`迷い ${state.mark_count}（押すと印を追加）`}
          aria-describedby={statusId}
          disabled={blocked}
          {...press}
        >
          <span className="lbl">迷い</span>
          <span className="num">{state.mark_count}</span>
          <span
            className={classNames('dot', state.status !== 'recording' && state.status)}
            aria-hidden="true"
            title={statusText(state)}
          />
        </button>
      </section>
      <p className="sr-only" id={statusId}>
        {statusText(state)}
      </p>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
