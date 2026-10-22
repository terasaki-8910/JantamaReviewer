/**
 * 週の集計（F8、U-30、R11-12）。週（月曜から日曜。日の区切りは午前 4 時。検討ログと同じ）を ← → で行き来し、その週の数・
 * 差の原因の割合と直近 8 週の推移・局面の種類・自分の〇△✕と AI 基準の一致率とずれ・成績（手入力）・来週の重点を出す。
 * 数は、保存した答えと、取り込んだ半荘から出す（数え方は weekModel.ts、元の数の組み立ては weekSource.ts）。消した半荘は数えない（D-3）。
 * 成績と重点は、手で入れて、study.sqlite の weeks 表に保存する（useWeekRecords.ts）。成績（手入力）の下には、別の表として、
 * 取り込んだ半荘の記録だけから数えた値（4 位率・放銃率・平均順位・和了率・副露率・立直率・平均和了点）を出す（F14、U-37。
 * 組み立ては importedStats.ts、画面は ImportedStatsSection.tsx）。手入力の値には触れない。
 *
 * 開いたときは今週。週は、このページの中だけの状態（ほかの画面へ移って戻ると、今週に戻る）。
 * 画面の作りは、承認済みの見本（11回目の week.html）のとおり。操作の説明の文は、説明のアイコン（R11-1）に載せる。
 */
import { addDays } from '@jantama/engine';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { SessionRecord } from '../../api/types';
import { Icon } from '../Icon';
import { weekStart } from '../log/logModel';
import type { SummaryMap } from '../sessionSummaries';
import { StudyNotice } from '../study/StudyNotice';
import { useStudy } from '../study/StudyProvider';
import { ChartTipProvider } from './ChartTip';
import { ImportedStatsSection } from './ImportedStatsSection';
import {
  CausesSection,
  EvaluationSection,
  FocusSection,
  PhaseSection,
  RecordSection,
  TilesSection,
} from './WeekSections';
import { buildImportedStats } from './importedStats';
import { summarizeWeeks, weekBounds, weekRangeText, weeksEndingAt } from './weekModel';
import { buildWeekSource, earliestWeek } from './weekSource';
import { useWeekRecords } from './useWeekRecords';

interface WeekPageProps {
  /** 消していない半荘（一覧に出ているもの）。 */
  sessions: readonly SessionRecord[];
  /** 結果を取り込んだ半荘のまとめ（段階は、MAKA の評価から合わせ直した当てはめのもの）。 */
  summaries: SummaryMap;
}

export function WeekPage({ sessions, summaries }: WeekPageProps) {
  const study = useStudy();
  const { ready, error, studyDay, answers, locate, gameState, doubtOnly } = study;
  const { problems } = study.model;
  const records = useWeekRecords();

  // 見ている週。null は「今週」（午前 4 時をまたぐと、今週も替わる）
  const [selected, setSelected] = useState<string | null>(null);
  const current = weekStart(studyDay);
  const recordWeeks = useMemo(() => [...records.records.keys()], [records.records]);
  const earliest = useMemo(
    () => (ready ? earliestWeek({ sessions, answers, locate, recordWeeks }) : null),
    [ready, sessions, answers, locate, recordWeeks],
  );
  const bounds = weekBounds(current, earliest);
  const week = selected === null ? current : selected < bounds.min ? bounds.min : selected > bounds.max ? bounds.max : selected;
  const isCurrent = week === current;
  const atMin = week <= bounds.min;
  const atMax = week >= bounds.max;

  const weeks = useMemo(() => weeksEndingAt(week), [week]);
  const byWeek = useMemo(() => {
    if (!ready) return null;
    const source = buildWeekSource({ sessions, summaries, answers, locate, gameState, problems, weeks: new Set(weeks) });
    return summarizeWeeks(weeks, source);
  }, [ready, sessions, summaries, answers, locate, gameState, problems, weeks]);

  // 取り込んだ半荘から数えた成績（見ている週だけ。週・半荘・読み込みの進みが替わるたびに数え直す。半荘ごとの数は、結果ごとに覚えている）
  const imported = useMemo(
    () => (ready ? buildImportedStats({ sessions, summaries, gameState, week }) : null),
    [ready, sessions, summaries, gameState, week],
  );

  // ← → を押して、押したほうのボタンが使えなくなったら（端の週に着いたら）、もう一方へキーボードの位置を移す
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const pressed = useRef<'prev' | 'next' | null>(null);
  useEffect(() => {
    if (pressed.current === 'prev' && atMin) nextButton.current?.focus();
    if (pressed.current === 'next' && atMax) prevButton.current?.focus();
    pressed.current = null;
  }, [week, atMin, atMax]);

  if (!ready || byWeek === null) {
    return error === null ? (
      <StudyNotice title="週の集計">読み込み中です。</StudyNotice>
    ) : (
      <StudyNotice title="週の集計" alert>
        答えの記録を読めませんでした: {error}
      </StudyNotice>
    );
  }
  const summary = byWeek.get(week);
  if (summary === undefined) return null;
  const previousWeek = addDays(week, -7);
  const windowProps = { weeks, byWeek, summary, isCurrent };
  const importedSection = imported === null ? null : <ImportedStatsSection stats={imported} />;

  return (
    <ChartTipProvider>
      <header className="head qhead">
        <div className="q-main">
          <div className="q-l">
            <h1 className="title">週の集計</h1>
          </div>
        </div>
      </header>
      <div className="page">
        <div className="wk-head">
          <div className="wk-switch" role="group" aria-label="週を選ぶ">
            <button
              type="button"
              className="icon-btn"
              ref={prevButton}
              aria-label="前の週"
              title="前の週"
              disabled={atMin}
              onClick={() => {
                pressed.current = 'prev';
                setSelected(addDays(week, -7));
              }}
            >
              <Icon name="arrowLeft" />
            </button>
            <span className="wk-range" aria-live="polite">
              {weekRangeText(week)}
            </span>
            <button
              type="button"
              className="icon-btn"
              ref={nextButton}
              aria-label="次の週"
              title="次の週"
              disabled={atMax}
              onClick={() => {
                pressed.current = 'next';
                const next = addDays(week, 7);
                setSelected(next >= current ? null : next);
              }}
            >
              <Icon name="arrowRight" />
            </button>
          </div>
          {isCurrent && <span className="tag">今週</span>}
        </div>
        <TilesSection summary={summary} isCurrent={isCurrent} />
        <CausesSection {...windowProps} week={week} />
        <PhaseSection summary={summary} />
        {/* 迷いだけを記録する設定が入のときは、〇△✕ を使う区画（一致率と、結果ごとのずれ。表で見る、も）を出さない（F0、U-46） */}
        {!doubtOnly && <EvaluationSection {...windowProps} />}
        {records.error !== null && (
          // 読めなかったときは、入力欄を出さない（読めていない保存済みの値を、空の欄から上書きしてしまわないため）
          <>
            <p className="notice" role="alert">
              成績と重点を読めませんでした: {records.error}
            </p>
            {importedSection}
          </>
        )}
        {records.loaded && records.error === null && (
          <>
            <RecordSection weeks={weeks} records={records.records} save={records.save} />
            {importedSection}
            <FocusSection
              week={week}
              previous={records.records.get(previousWeek)?.focus ?? ''}
              stored={records.records.get(week)?.focus ?? ''}
              save={records.save}
            />
          </>
        )}
      </div>
    </ChartTipProvider>
  );
}
