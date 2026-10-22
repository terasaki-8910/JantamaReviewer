import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DEFAULT_DISAGREEMENT_THRESHOLD, listDecisionRefs, type DecisionRef, type Grade } from '@jantama/engine';

import { api } from '../api/tauri';
import type { RatingEntry, SelfRatingValue, SessionRecord } from '../api/types';
import { RATING_GLYPH, RatingShape } from '../shared/RatingShape';
import { formatClock, formatSessionTitle } from './format';
import { GradeBadge } from './GradeBadge';
import { ExtraMemos } from './ExtraMemos';
import { buildHandTable, type HandRow } from './handRows';
import { HandTable, MARK_CHIPS_HINT, MARK_CHIPS_HINT_ID } from './HandTable';
import { makaCommand, selfRatingCommand } from './hanchanEdits';
import { initialFitState, type MakaFitState } from './makaFit';
import { useSessionReport } from './hanchanReport';
import type { ViewerItem, ViewerRequest } from './Lightbox';
import { chipsByKyoku } from './markChips';
import { resolveMarks } from './markCards';
import { MarkCard } from './MarkCard';
import { MarkMemoFields } from './MarkMemoFields';
import { MyShantenTrack } from './MyShantenTrack';
import { MEMO_INTRO, memoOfMark } from './memos';
import { ReplayIcon } from './replay/ReplayIcons';
import { IDLE_REREADS, type Rereads } from './rereadStore';
import type { SummaryState } from './sessionSummaries';
import { InfoTip } from './InfoTip';
import { ImportHereButton, TargetImportPanel } from './TargetImport';
import { useUndo } from './undo/UndoProvider';
import type { ImportFlow } from './useImportFlow';
import { useMarkLink } from './useMarkLink';
import { viewerItemOf } from './viewerItems';

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
  /**
   * 取り込みの状態（検討画面のシェルが 1 つだけ持つ）。渡すと、取り込み前の半荘に「この半荘に検討結果を取り込む」を出し、
   * この半荘に取り込んでいる間の進み具合を、このページの中に出す（U-14）。
   */
  importFlow?: ImportFlow;
  /**
   * 前の作り方で読んだ半荘の読み直し（検討画面のシェルが 1 つだけ持つ。F11、E-27、U-23）。渡すと、取り込んだ半荘を開いたとき、
   * 読み取りの写しが前の作り方で読んだものなら、この起動で 1 回だけ、保存してあるスクショを読み直し、読み直している間は、
   * 迷いの見出しのとなりに、静かな 1 行を出す。渡さなければ、読み直さない。
   */
  rereads?: Rereads;
  /**
   * 半荘を通して見る画面を開く（F12）。渡すと、結果を取り込んだ半荘に「この半荘を通して見る」を出し、迷いのカードに「この局面を解く」
   * （そのカードの局面で開く）を出す。
   */
  onOpenReplay?: (sessionId: string, key?: string) => void;
  /**
   * MAKA の当てはめの状態（検討画面のシェルが 1 つだけ持つ。F10、U-31）。渡すと、局の評価の表の下に、当てはめの見込みの 1 行を出す。
   * このページで MAKA の評価を入れて当てはめが替わったら、「合わせ直しました」も出す。渡さなければ、基礎の 67 局の見込みを出す。
   */
  fit?: MakaFitState;
  /**
   * 大きな不一致の基準（確率。設定の「大きな不一致の基準」。検討画面のシェルが渡す）。局の評価の表の行を開いたときの向聴数の推移の、
   * 大きな不一致の印（菱形）に使う（U-36）。渡さなければ、既定の 5%。
   */
  threshold?: number;
}

const noop = () => Promise.resolve();

/** 当てはめの状態を渡されなかったときの、基礎の 67 局だけの見込み。 */
const BASE_FIT_STATE = initialFitState();

/** 局の評価の表の札から移ったあと、迷いのカードを目立たせておく時間（ミリ秒）。 */
export const FLASH_MS = 1800;

/**
 * 半荘 1 つのページ。見出し（日時・卓・段階・Rating）・迷いのカード（F9）・局の評価の表（F10）。
 * 結果を取り込む前の半荘は、迷いのカード（「迷いN」と時刻だけ）と、記録した〇△✕の一覧だけ。
 * AI の候補・確率・順位は出さない（SPEC F3。答えを書くまで隠す）。段階と Rating は、見出しと表にある。
 */
export function SessionPage({
  session,
  summary,
  onChanged = noop,
  onOpenImage,
  importFlow,
  rereads = IDLE_REREADS,
  onOpenReplay,
  fit = BASE_FIT_STATE,
  threshold = DEFAULT_DISAGREEMENT_THRESHOLD,
}: SessionPageProps) {
  const titleId = useId();
  const marksId = useId();
  const handsId = useId();
  const undo = useUndo();
  const reportState = useSessionReport(session.id, session.report_path);
  // 前の作り方で読んだ写しは、開いたとき 1 回だけ読み直す（読み直す間は、前の読み取りの値で描く。済んだら、一覧が読み直されて、描き直す）。
  const rereading = useSyncExternalStore(rereads.subscribe, rereads.getSnapshot).has(session.id);
  // 読み取りの写しがあれば、読み直しが要るかを確かめる。写しが無くても、結果を取り込んである半荘は、評価の当てはめ直しを確かめる（E-31）
  const imported = session.report_path !== null;
  const hasReadings = imported && session.ocr !== null;
  useEffect(() => {
    if (imported) rereads.open(session.id, { reread: hasReadings });
  }, [rereads, session.id, imported, hasReadings]);
  const ready = summary?.status === 'ready' ? summary.summary : null;
  const report = reportState.status === 'ready' ? reportState.report : null;
  // 結果を取り込んで、読めている半荘は、通して見られる
  const replayable = onOpenReplay !== undefined && session.report_path !== null && ready !== null;
  const when = formatSessionTitle(session.started_ms);
  // この半荘に取り込む（U-14）: 取り込み前なら、主な操作を見出しに出す。始められなかった理由は、ページの上に出す。
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const canImportHere = importFlow !== undefined && session.report_path === null;
  const importingHere =
    importFlow !== undefined && importFlow.target?.sessionId === session.id && importFlow.state.phase !== 'prompt';
  // 進み具合の知らせを閉じたら（やめる・閉じる）、押したボタンがまだあればそこへ、取り込みが済んでボタンが消えていれば見出しへ、
  // キーボードの位置を戻す（知らせの中のボタンが消えて、位置が失われないように）。
  const actionRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const wasImporting = useRef(false);
  useEffect(() => {
    if (wasImporting.current && !importingHere) (actionRef.current ?? titleRef.current)?.focus();
    wasImporting.current = importingHere;
  }, [importingHere]);

  const resolved = useMemo(() => (report === null ? null : resolveMarks(report, session)), [report, session]);
  const decisions = useMemo<DecisionRef[]>(() => (report === null ? [] : listDecisionRefs(report)), [report]);
  const table = useMemo(
    () => (report === null || ready === null ? null : buildHandTable({ report, summary: ready, session })),
    [report, ready, session],
  );
  // 局の評価の表の「迷い」の列の札（迷いのカードと同じ結びつけから。U-27）
  const chips = useMemo(() => (resolved === null ? undefined : chipsByKyoku(resolved)), [resolved]);
  // 局の評価の表の行を開いたときの、向聴数の推移（U-36）: 迷いごとの、結びつけた判断の鍵（迷いの番号は、並びの位置 + 1）
  const markKeys = useMemo(
    () => (resolved ?? []).map((mark) => (mark.resolution.kind === 'linked' ? mark.resolution.ref.key : null)),
    [resolved],
  );
  const myTrackBelow = useCallback(
    (row: HandRow) =>
      report === null ? null : (
        <MyShantenTrack report={report} position={row.position} label={row.label} markKeys={markKeys} threshold={threshold} />
      ),
    [report, markKeys, threshold],
  );

  // 札を押すと、その迷いのカードへ移って、少しの間目立たせる（キーボードの位置もカードへ移す）
  const cards = useRef(new Map<number, HTMLElement>());
  const [flash, setFlash] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
  const jumpToMark = useCallback((markId: number) => {
    const card = cards.current.get(markId);
    if (card === undefined) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    card.focus({ preventScroll: true });
    setFlash(markId);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  // 保存して、取り消せる命令にする（出題・通して見る画面の「迷いのスクショ」の付け替えと同じ操作）
  const chooseDecision = useMarkLink(session.id, onChanged);

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

  // このページで MAKA の評価を入れたときの、当てはめの版。これより新しい当てはめになったら、「合わせ直しました」を出す
  // （最初の読み込みで、すでに入れてある評価を取り込んだだけの替わり方では、出さない）。最初の 1 回の入力のときだけ決める
  const [editedAt, setEditedAt] = useState<number | null>(null);
  const refit = editedAt !== null && fit.revision > editedAt;

  const changeMaka = (row: HandRow | null, grade: Grade | undefined) => {
    const current = row === null ? table?.hanchan.maka : row.maka;
    if (grade === (current ?? undefined)) return;
    setEditedAt((at) => at ?? fit.revision);
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
      const item = viewerItemOf(mark, i + 1, resolved?.[i] ?? null);
      if (item === null) return;
      indexOf.set(mark.id, items.length);
      items.push(item);
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
          <h1 className="title" id={titleId} ref={titleRef} tabIndex={-1}>
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
        {(replayable || (ready !== null && ready.grade !== null)) && (
          <div className="head-actions">
            {replayable && (
              <button type="button" className="btn primary" onClick={() => onOpenReplay?.(session.id)}>
                <ReplayIcon name="play" />
                この半荘を通して見る
              </button>
            )}
            {ready !== null && ready.grade !== null && (
              <div className="head-score">
                <GradeBadge grade={ready.grade} size="lg" />{' '}
                <span className="rate-num">{ready.ratingText}</span> <span className="rate-lbl">Rating</span>
              </div>
            )}
          </div>
        )}
        {canImportHere && (
          <ImportHereButton session={session} flow={importFlow} onNotice={setImportNotice} buttonRef={actionRef} />
        )}
      </header>
      <div className="page">
        <div className="detail">
          {canImportHere && importNotice !== null && (
            <p className="notice" role="alert">
              {importNotice}
            </p>
          )}
          {importingHere && <TargetImportPanel flow={importFlow} />}
          <section aria-labelledby={marksId}>
            <div className="sec-head">
              <h2 className="sec-title" id={marksId}>
                迷い（{session.marks.length}）
              </h2>
              <InfoTip label="終局直後のメモの説明">{MEMO_INTRO}</InfoTip>
              {rereading && (
                <p className="quiet" role="status">
                  スクショを新しい読み取りで読み直しています
                </p>
              )}
            </div>
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
                      onSolve={replayable ? (key) => onOpenReplay?.(session.id, key) : undefined}
                      flash={flash === mark.id}
                      cardRef={(element) => {
                        if (element === null) cards.current.delete(mark.id);
                        else cards.current.set(mark.id, element);
                      }}
                      memo={
                        <MarkMemoFields
                          sessionId={session.id}
                          markId={mark.id}
                          number={index + 1}
                          saved={memoOfMark(session.memos, mark.id)}
                          reload={onChanged}
                        />
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            <ExtraMemos session={session} decisions={decisions} reload={onChanged} />
          </section>
          {table !== null ? (
            <section aria-labelledby={handsId}>
              <div className="sec-head">
                <h2 className="sec-title" id={handsId}>
                  局の評価
                </h2>
                {chips !== undefined && chips.size > 0 && (
                  <InfoTip label="迷いの札の説明" id={MARK_CHIPS_HINT_ID}>
                    {MARK_CHIPS_HINT}
                  </InfoTip>
                )}
              </div>
              <HandTable
                table={table}
                onSelfRating={changeSelfRating}
                onMaka={changeMaka}
                chips={chips}
                onJumpToMark={jumpToMark}
                fit={fit}
                refit={refit}
                report={report ?? undefined}
                detailBelow={myTrackBelow}
              />
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
