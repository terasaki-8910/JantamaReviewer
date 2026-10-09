import { convertFileSrc } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

import { api, errorMessage, onStateChanged } from '../api/tauri';
import type { MarkRecord, RatingEntry, SessionRecord } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';
import { formatClock, formatSessionTitle } from './format';

/**
 * 記録ページ。半荘の一覧と、選んだ半荘の迷いマーク（スクリーンショットと時刻）・評価（局の順）。
 * ウィジェットで記録するたびに、その場で更新する。
 */
export function RecordsPage() {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listSessions()
      .then((list) => {
        setSessions(list);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(errorMessage(error)));
  }, []);

  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | null = null;
    reload();
    void onStateChanged(reload).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, [reload]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? sessions?.[0] ?? null;

  return (
    <>
      <header className="head">
        <h1 className="title">記録</h1>
      </header>
      <div className="page">
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        {sessions && sessions.length === 0 && !loadError && (
          <p className="empty">
            まだ記録がありません。ウィジェットの「迷い」や〇△✕を押すと、ここに並びます。
          </p>
        )}
        {sessions && sessions.length > 0 && (
          <div className="records">
            <nav aria-label="半荘の一覧">
              <ul className="session-list">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="session-row"
                      aria-current={session.id === selected?.id ? 'true' : undefined}
                      onClick={() => setSelectedId(session.id)}
                    >
                      <span className="session-when">{formatSessionTitle(session.started_ms)}</span>
                      <span className="session-counts">
                        <span>
                          迷い <b>{session.mark_count}</b>
                        </span>
                        <span>
                          評価 <b>{session.rating_count}</b>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            {selected && <SessionDetail session={selected} />}
          </div>
        )}
      </div>
    </>
  );
}

function SessionDetail({ session }: { session: SessionRecord }) {
  return (
    <section className="detail" aria-labelledby="detail-title">
      <div className="detail-head">
        <h2 className="detail-title" id="detail-title">
          {formatSessionTitle(session.started_ms)}
        </h2>
      </div>
      <div>
        <h3 className="sec-title">迷い（{session.marks.length}）</h3>
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
        <h3 className="sec-title">評価（{session.ratings.length}）</h3>
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
  );
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
