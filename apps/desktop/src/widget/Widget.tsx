import type { AppState, Orientation, Rating, Status } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';

const RATINGS: readonly Rating[] = ['good', 'fair', 'bad'];

const STATUS_LABEL: Record<Status, string> = {
  recording: '記録中',
  idle: '待機中',
  error: '保存先エラー',
};

export interface WidgetProps {
  orientation: Orientation;
  state: AppState;
  /** 押した直後の光り（キーは `doubt`・`rate-good` など）。 */
  flashing: Readonly<Record<string, boolean>>;
  /** 読み上げ用の文（aria-live）。 */
  announcement: string;
  onRate: (rating: Rating) => void;
  onMark: () => void;
  onUndo: () => void;
}

function classNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/**
 * ウィジェット（表示だけ）。承認済みのサンプルの縦長・横長をそのまま再現する。
 * 見た目の優先順は 評価 > 迷い > 取り消し。ボタンはすべて 40px 以上。
 */
export function Widget({
  orientation,
  state,
  flashing,
  announcement,
  onRate,
  onMark,
  onUndo,
}: WidgetProps) {
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
