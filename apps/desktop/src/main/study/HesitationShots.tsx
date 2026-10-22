/**
 * 迷いのスクショの欄（F12、U-45。2026-10-22 の依頼「この迷いってこのシーンであってたかの確認が若干ムズイ」。選んだ案は「場面の横にスクショ」）。
 * 迷いマークを結びつけた場面で、答えの欄のいちばん上（スクロールする部分の頭）に、その迷いのスクショの小さな写真・「迷いN」・結びつけの状態
 * （推定・選んだ）・スクショから読んだ値（局・残り枚数・点数）を出す。写真を押すと大きく見られる（Esc・外の押下で閉じ、キーボードの位置は写真に戻る）。
 * 「前の手に付け替える」「次の手に付け替える」で、その迷いを自分の前・次の判断（半荘の順）に付け替える。保存は半荘のページと同じ
 * （利用者の選びとして links.json に入り、Ctrl+Z で戻る。`useMarkLink`）。最初・最後の判断では、その向きは押せない。
 * 付け替えたあとのふるまいは、呼ぶ側が決める（通して見る画面は付け替えた先の場面へ移る。出題は、その問題のまま、読み上げの文を出す）。
 * AI の情報は出さない（答える前から出してよい）。
 */
import type { DecisionRef } from '@jantama/engine';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { SessionRecord } from '../../api/types';
import { MarkThumb } from '../MarkThumb';
import { ESTIMATE_TAG, isEstimated, readingLine, type ResolvedMark } from '../markCards';
import { useMarkLink } from '../useMarkLink';
import { viewerItemOf } from '../viewerItems';
import { useOpenViewer } from '../ViewerContext';
import { marksOfDecision, neighbourDecisions } from './shotMarks';
import { useStudy } from './StudyProvider';

interface HesitationShotsProps {
  /** 画面の場面（判断）の鍵。 */
  decisionKey: string;
  session: SessionRecord;
  /** 半荘の迷いごとの結びつけ（記録の順）。 */
  resolved: readonly ResolvedMark[];
  /** この半荘のすべての判断（前・次の手を決める）。 */
  decisions: readonly DecisionRef[];
  /** 付け替えて、保存できたあと（付け替えた迷いと、付け替えた先の判断）。 */
  onRelinked: (mark: ResolvedMark, to: DecisionRef) => void;
  /** 付け替えたあとの画面で、キーボードの位置を渡す迷いの記録の番号（その迷いの写真へ）。渡したら、`onFocusDone` で知らせる。 */
  focusMarkId?: number | null;
  onFocusDone?: () => void;
}

export function HesitationShots({ decisionKey, session, resolved, decisions, onRelinked, focusMarkId = null, onFocusDone }: HesitationShotsProps) {
  const study = useStudy();
  const relink = useMarkLink(session.id, study.reloadSessions);
  const openViewer = useOpenViewer();
  const headingId = useId();
  const shown = useMemo(() => marksOfDecision(resolved, decisionKey), [resolved, decisionKey]);
  const { prev, next } = useMemo(() => neighbourDecisions(decisions, decisionKey), [decisions, decisionKey]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 大きく表示する画像（この欄の迷いのうち、画像のあるもの）
  const viewer = useMemo(() => {
    const items = [];
    const indexOf = new Map<number, number>();
    for (const item of shown) {
      const mark = session.marks[item.number - 1];
      const entry = mark === undefined ? null : viewerItemOf(mark, item.number, item);
      if (mark === undefined || entry === null) continue;
      indexOf.set(mark.id, items.length);
      items.push(entry);
    }
    return { items, indexOf };
  }, [shown, session.marks]);

  // 付け替えたあと、写真へキーボードの位置を渡す（通して見る画面で、付け替えた先の場面に移ったあと）
  const thumbs = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focusMarkId === null) return;
    const target = thumbs.current?.querySelector<HTMLElement>(`[data-thumb="${focusMarkId}"], [data-shot="${focusMarkId}"] button`);
    if (target === null || target === undefined) return;
    target.focus({ preventScroll: true });
    onFocusDone?.();
  }, [focusMarkId, onFocusDone, shown]);

  if (shown.length === 0) return null;

  const open = (markId: number, opener: HTMLElement) => {
    const start = viewer.indexOf.get(markId);
    if (start !== undefined) openViewer?.({ items: viewer.items, start, opener });
  };

  const move = async (item: ResolvedMark, to: DecisionRef | null) => {
    if (to === null || busy) return;
    setBusy(true);
    try {
      await relink(item, to);
      onRelinked(item, to);
    } catch {
      // 失敗の理由は、取り消しの積み重ねの知らせが通知に出す。この欄は、付け替える前のまま
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section className="q-sec shots" aria-labelledby={headingId} data-shots="block" ref={thumbs}>
      <h2 className="sec-title" id={headingId}>
        迷いのスクショ
      </h2>
      <ul className="shot-list">
        {shown.map((item) => {
          const mark = session.marks[item.number - 1];
          if (mark === undefined) return null;
          return (
            <li className="shot" key={item.markId} data-shot={item.markId}>
              <MarkThumb mark={mark} number={item.number} onOpen={(opener) => open(mark.id, opener)} />
              <div className="shot-body">
                <p className="shot-top">
                  <b className="shot-n">迷い{item.number}</b>
                  {isEstimated(item) ? <span className="tag est">{ESTIMATE_TAG}</span> : <span className="tag">選んだ</span>}
                </p>
                <p className="shot-read">{readingLine(item)}</p>
              </div>
              <div className="shot-actions">
                <button
                  type="button"
                  className="btn sm wrap"
                  disabled={prev === null || busy}
                  aria-label={`迷い${item.number}を前の手に付け替える`}
                  onClick={() => void move(item, prev)}
                >
                  前の手に付け替える
                </button>
                <button
                  type="button"
                  className="btn sm wrap"
                  disabled={next === null || busy}
                  aria-label={`迷い${item.number}を次の手に付け替える`}
                  onClick={() => void move(item, next)}
                >
                  次の手に付け替える
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
