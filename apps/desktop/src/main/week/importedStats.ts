/**
 * 週の集計の「取り込んだ半荘から数えた値（参考）」の元になる数（F14、E-42、U-37。R15-7 の B、R14-4）を、取り込んだ半荘から組み立てる。
 *
 * - 数える半荘: 消していない半荘（一覧に出ているもの。ごみ箱の半荘は、一覧に無いので数えない）のうち、結果を取り込んでいて、
 *   半荘を始めた時刻が見ている週（月曜から日曜。日の区切りは午前 4 時。週の集計のほかの数と同じ `weekOfInstant`）に入るもの
 * - 数え方はエンジンの `hanchanStatOf`・`totalStats`（雀魂の成績の画面は読まない。取り込んだ牌譜だけから数える）
 * - まだ読み込み中の半荘と、牌譜が読めず数えられない半荘は、数に入れず、その数を持つ（画面が一言添える）
 * 半荘ごとの数は、結果を読み直した（`MortalReport` が替わった）ときだけ数え直す（局を 1 つずつ再生するので、少し重い）。
 */
import { hanchanStatOf, totalStats, type HanchanStat, type HanchanStatTotals, type MortalReport } from '@jantama/engine';

import type { SessionRecord } from '../../api/types';
import { formatSessionTitle } from '../format';
import type { SummaryMap } from '../sessionSummaries';
import type { GameState } from '../study/gameStore';
import { weekOfInstant } from './weekModel';

/** 半荘ごとの行。 */
export interface ImportedHanchanRow {
  id: string;
  /** 半荘の呼び名。例: 10月9日(金) 19:09。 */
  label: string;
  /** 卓の呼び名。例: 玉の間・南。まとめが読めていなければ null。 */
  room: string | null;
  stat: HanchanStat;
  /** その半荘の平均和了点。和了が無ければ null。 */
  averageWinPoints: number | null;
}

/** 見ている週の、取り込んだ半荘から数えた成績。 */
export interface ImportedWeekStats {
  /** その週に取り込んだ（結果のある）半荘の数。数えられなかったものも含む。 */
  imported: number;
  /** まだ読み込み中の半荘の数。 */
  loading: number;
  /** 牌譜が読めず、数えられなかった半荘の数。 */
  unreadable: number;
  /** 数えた半荘（古い順）。 */
  rows: ImportedHanchanRow[];
  /** 数えた半荘をまとめた、もとの数と値。 */
  totals: HanchanStatTotals;
}

/** 結果ごとの数（局を再生するので、結果を読み直さないかぎり覚えておく）。null は、数えられなかった。 */
const statCache = new WeakMap<MortalReport, HanchanStat | null>();

function statOf(report: MortalReport): HanchanStat | null {
  const cached = statCache.get(report);
  if (cached !== undefined) return cached;
  let stat: HanchanStat | null;
  try {
    stat = hanchanStatOf(report);
  } catch {
    stat = null;
  }
  statCache.set(report, stat);
  return stat;
}

export interface ImportedStatsInput {
  /** 消していない半荘（一覧に出ているもの）。 */
  sessions: readonly SessionRecord[];
  summaries: SummaryMap;
  gameState: (sessionId: string) => GameState | undefined;
  /** 見ている週の月曜（YYYY-MM-DD）。 */
  week: string;
}

export function buildImportedStats(input: ImportedStatsInput): ImportedWeekStats {
  const { sessions, summaries, gameState, week } = input;
  const inWeek = sessions
    .filter((session) => session.report_path !== null && weekOfInstant(session.started_ms) === week)
    .sort((a, b) => a.started_ms - b.started_ms);
  const rows: ImportedHanchanRow[] = [];
  let loading = 0;
  let unreadable = 0;
  for (const session of inWeek) {
    const state = gameState(session.id);
    if (state === undefined || state.status === 'loading') {
      loading += 1;
      continue;
    }
    const stat = state.status === 'ready' ? statOf(state.game.report) : null;
    if (stat === null) {
      unreadable += 1;
      continue;
    }
    const summary = summaries.get(session.id);
    rows.push({
      id: session.id,
      label: formatSessionTitle(session.started_ms),
      room: summary?.status === 'ready' ? summary.summary.room : null,
      stat,
      averageWinPoints: stat.winCount === 0 ? null : stat.winPointsSum / stat.winCount,
    });
  }
  return { imported: inWeek.length, loading, unreadable, rows, totals: totalStats(rows.map((row) => row.stat)) };
}
