import { convertFileSrc } from '@tauri-apps/api/core';
import { useId } from 'react';

import type { MarkRecord, RatingEntry, SessionRecord } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';
import { formatClock, formatSessionTitle } from './format';
import { GradeBadge } from './GradeBadge';
import type { SummaryState } from './sessionSummaries';

interface SessionPageProps {
  session: SessionRecord;
  /** 取り込んだ結果のまとめ。取り込む前の半荘は undefined。 */
  summary: SummaryState | undefined;
}

/**
 * 半荘 1 つのページ。見出し（日時・卓・段階・Rating）と、迷いマーク（スクリーンショットと時刻）・評価（局の順）。
 * 半荘のページそのもの（迷いのカード・局の評価の比較）は、次の作業で作り替える。いまは、記録のページにあった中身を、そのまま出す。
 */
export function SessionPage({ session, summary }: SessionPageProps) {
  const titleId = useId();
  const ready = summary?.status === 'ready' ? summary.summary : null;
  const when = formatSessionTitle(session.started_ms);

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
        <section className="detail" aria-labelledby={titleId}>
          <div>
            <h2 className="sec-title">迷い（{session.marks.length}）</h2>
            {session.marks.length === 0 ? (
              <p className="empty">迷いの記録はありません。</p>
            ) : (
              <ul className="marks" aria-label="迷いマークの一覧">
                {session.marks.map((mark, index) => (
                  <li key={mark.id}>
                    <MarkItem mark={mark} number={index + 1} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="sec-title">評価（{session.ratings.length}）</h2>
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
          </div>
        </section>
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

function MarkItem({ mark, number }: { mark: MarkRecord; number: number }) {
  const clock = formatClock(mark.t_ms);
  return (
    <figure className="mark">
      {mark.screenshot_path ? (
        <img
          className="thumb"
          src={convertFileSrc(mark.screenshot_path)}
          alt={`迷い ${number} のスクリーンショット（${clock}）`}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <div className="thumb-empty" title={mark.capture_error ?? undefined}>
          画像なし
        </div>
      )}
      <figcaption className="mark-cap">
        <span>迷い {number}</span>
        <span className="mono">{clock}</span>
      </figcaption>
    </figure>
  );
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
