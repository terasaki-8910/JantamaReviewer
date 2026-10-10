import { convertFileSrc } from '@tauri-apps/api/core';
import { useId, useMemo } from 'react';

import { listDecisionRefs, type DecisionRef, type Grade } from '@jantama/engine';

import { api } from '../api/tauri';
import type { RatingEntry, SelfRatingValue, SessionRecord } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';
import { formatClock, formatSessionTitle } from './format';
import { GradeBadge } from './GradeBadge';
import { buildHandTable, type HandRow } from './handRows';
import { HandTable } from './HandTable';
import { makaCommand, markLinkCommand, selfRatingCommand } from './hanchanEdits';
import { useSessionReport } from './hanchanReport';
import type { ViewerItem, ViewerRequest } from './Lightbox';
import { markCaptionParts, resolveMarks, type ResolvedMark } from './markCards';
import { MarkCard } from './MarkCard';
import type { SummaryState } from './sessionSummaries';
import { useUndo } from './undo/UndoProvider';

interface SessionPageProps {
  session: SessionRecord;
  /** 取り込んだ結果のまとめ。取り込む前の半荘は undefined。 */
  summary: SummaryState | undefined;
  /**
   * 保存したあと（取り消し・やり直しのあとも）に、半荘の一覧を読み直す。画面に反映するため。
   * 取り消しは、このページが閉じたあとにも働くので、呼び出す側が、ずっと使える関数を渡す。
   */
  onChanged?: () => Promise<void>;
  /** 迷いの画像を大きく表示する（表示は呼び出す側が持つ。裏の画面を操作できなくするため）。 */
  onOpenImage?: (request: ViewerRequest) => void;
}

const noop = () => Promise.resolve();

/**
 * 半荘 1 つのページ。見出し（日時・卓・段階・Rating）・迷いのカード（F9）・局の評価の表（F10）。
 * 結果を取り込む前の半荘は、迷いのカード（「迷いN」と時刻だけ）と、記録した〇△✕の一覧だけ。
 * AI の候補・確率・順位は出さない（SPEC F3。答えを書くまで隠す）。段階と Rating は、見出しと表にある。
 */
export function SessionPage({ session, summary, onChanged = noop, onOpenImage }: SessionPageProps) {
  const titleId = useId();
  const marksId = useId();
  const handsId = useId();
  const undo = useUndo();
  const reportState = useSessionReport(session.id, session.report_path);
  const ready = summary?.status === 'ready' ? summary.summary : null;
  const report = reportState.status === 'ready' ? reportState.report : null;
  const when = formatSessionTitle(session.started_ms);

  const resolved = useMemo(() => (report === null ? null : resolveMarks(report, session)), [report, session]);
  const decisions = useMemo<DecisionRef[]>(() => (report === null ? [] : listDecisionRefs(report)), [report]);
  const table = useMemo(
    () => (report === null || ready === null ? null : buildHandTable({ report, summary: ready, session })),
    [report, ready, session],
  );

  // 保存して、取り消せる命令にする。失敗は、取り消しの積み重ねの知らせが通知に出す（ここでは握りつぶさず、呼び出し元へ返す）。
  const chooseDecision = (item: ResolvedMark, ref: DecisionRef): Promise<void> =>
    undo.run(
      markLinkCommand(api, onChanged, {
        sessionId: session.id,
        markId: item.markId,
        number: item.number,
        before: item.stored,
        after: ref.key,
        where: `${ref.kyokuLabel} ${ref.junme}巡目`,
      }),
    );

  const changeSelfRating = (row: HandRow, value: SelfRatingValue) => {
    if (value === (row.self ?? 'none')) return;
    void undo
      .run(
        selfRatingCommand(api, onChanged, {
          sessionId: session.id,
          kyoku: row.key,
          label: row.label,
          before: row.override,
          after: value,
        }),
      )
      .catch(() => undefined);
  };

  const changeMaka = (row: HandRow | null, grade: Grade | undefined) => {
    const current = row === null ? table?.hanchan.maka : row.maka;
    if (grade === (current ?? undefined)) return;
    void undo
      .run(
        makaCommand(api, onChanged, {
          sessionId: session.id,
          kyoku: row?.key,
          label: row?.label ?? '半荘全体',
          before: current ?? undefined,
          after: grade,
        }),
      )
      .catch(() => undefined);
  };

  // 大きく表示する画像（画像のある迷いだけ）。caption は、カードの 1 行目と同じ内容。
  const viewer = useMemo(() => {
    const items: ViewerItem[] = [];
    const indexOf = new Map<number, number>();
    session.marks.forEach((mark, i) => {
      if (!mark.screenshot_path) return;
      const number = i + 1;
      const parts = [`迷い${number}`, ...markCaptionParts(resolved?.[i] ?? null)];
      indexOf.set(mark.id, items.length);
      items.push({
        src: convertFileSrc(mark.screenshot_path),
        alt: `迷い${number}のスクリーンショット`,
        caption: parts.join(' · '),
        time: formatClock(mark.t_ms),
      });
    });
    return { items, indexOf };
  }, [session.marks, resolved]);

  const openImage = (markId: number, opener: HTMLElement) => {
    const start = viewer.indexOf.get(markId);
    if (start !== undefined) onOpenImage?.({ items: viewer.items, start, opener });
  };

  // 取り込み済みで、結果をまだ読んでいる最中か（読めなかったときは、記録した評価の一覧を出す）。
  const readingReport =
    session.report_path !== null && summary?.status !== 'unavailable' && reportState.status !== 'unavailable';

  return (
    <>
      <header className="head session-head">
        <div className="head-l">
          <h1 className="title" id={titleId}>
            {when}
            {/* 狭い幅で折り返すときは、卓の名前の途中ではなく、卓の名前の前（空白のところ）で折り返す */}
            {ready?.room ? (
              <>
                {' '}
                <span className="nowrap">· {ready.room}</span>
              </>
            ) : null}
          </h1>
          <p className="quiet">{subtitle(session, summary)}</p>
        </div>
        {ready !== null && ready.grade !== null && (
          <div className="head-score">
            <GradeBadge grade={ready.grade} size="lg" />{' '}
            <span className="rate-num">{ready.ratingText}</span> <span className="rate-lbl">Rating</span>
          </div>
        )}
      </header>
      <div className="page">
        <div className="detail">
          <section aria-labelledby={marksId}>
            <h2 className="sec-title" id={marksId}>
              迷い（{session.marks.length}）
            </h2>
            {session.marks.length === 0 ? (
              <p className="empty">迷いの記録はありません。</p>
            ) : (
              <ul className="marks" aria-label="迷いマークの一覧">
                {session.marks.map((mark, index) => (
                  <li key={mark.id}>
                    <MarkCard
                      mark={mark}
                      number={index + 1}
                      resolved={resolved?.[index] ?? null}
                      decisions={decisions}
                      onOpenImage={(opener) => openImage(mark.id, opener)}
                      onChoose={chooseDecision}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {table !== null ? (
            <section aria-labelledby={handsId}>
              <h2 className="sec-title" id={handsId}>
                局の評価
              </h2>
              <HandTable table={table} onSelfRating={changeSelfRating} onMaka={changeMaka} />
            </section>
          ) : readingReport ? (
            <section aria-labelledby={handsId}>
              <h2 className="sec-title" id={handsId}>
                局の評価
              </h2>
              <p className="empty">読み込んでいます。</p>
            </section>
          ) : (
            <section aria-labelledby={handsId}>
              <h2 className="sec-title" id={handsId}>
                評価（{session.ratings.length}）
              </h2>
              {session.ratings.length === 0 ? (
                <p className="empty">評価はまだありません。</p>
              ) : (
                <ol className="rating-list" aria-label="局の評価の一覧">
                  {session.ratings.map((rating) => (
                    <li key={rating.id}>
                      <RatingRow rating={rating} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** 見出しの下の 1 行: 取り込み済みは「5局 · 東3局1本場で終了」、取り込み前は「取り込み前」と、記録の数。 */
function subtitle(session: SessionRecord, summary: SummaryState | undefined): string {
  if (session.report_path === null) {
    return `取り込み前 · 迷い ${session.mark_count} · 評価 ${session.rating_count}`;
  }
  if (summary?.status === 'ready') {
    const last = summary.summary.kyokus.at(-1);
    const count = `${summary.summary.kyokus.length}局`;
    return last ? `${count} · ${last.label}で終了` : count;
  }
  if (summary?.status === 'unavailable') {
    return `取り込んだ結果を読めませんでした（${summary.reason}）`;
  }
  return `迷い ${session.mark_count} · 評価 ${session.rating_count}`;
}

function RatingRow({ rating }: { rating: RatingEntry }) {
  return (
    <div className="rating-row">
      <span>{rating.hand}局目</span>
      <span className="glyph" role="img" aria-label={RATING_GLYPH[rating.rating]}>
        <RatingShape rating={rating.rating} />
      </span>
      <span className="mono">{formatClock(rating.t_ms)}</span>
    </div>
  );
}
