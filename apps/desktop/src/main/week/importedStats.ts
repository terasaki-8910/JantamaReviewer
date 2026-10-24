/**
 * 週の集計の「取り込んだ半荘から数えた値（参考）」の元になる数（F14、E-42、U-37。R15-7 の B、R14-4）を、取り込んだ半荘から組み立てる。
 *
 * - 数える半荘: 消していない半荘（一覧に出ているもの。ごみ箱の半荘は、一覧に無いので数えない）のうち、結果を取り込んでいて、
 *   半荘を始めた時刻が見ている週（月曜から日曜。日の区切りは午前 4 時。週の集計のほかの数と同じ `weekOfInstant`）に入るもの
 * - 数え方はエンジンの `hanchanStatOf`・`totalStats`（雀魂の成績の画面は読まない。取り込んだ牌譜だけから数える）
 * - まだ読み込み中の半荘と、牌譜が読めず数えられない半荘は、数に入れず、その数を持つ（画面が一言添える）
 * 半荘ごとの数は、結果を読み直した（`MortalReport` が替わった）ときだけ数え直す（局を 1 つずつ再生するので、少し重い）。
 *
 * AI 一致率・類似度・悪手率（F18、E-48、U-48）も、同じ半荘（数える半荘と同じ絞り込み）から、エンジンの `aiMetricsOf`・`totalAiMetrics` で数える。
 * 悪手の基準は、設定の「大きな不一致の基準」（`threshold`。確率）。判断を数えるだけで軽いので、基準が替わるたびに数え直し、覚えない。
 */
import {
  aiMetricsOf,
  hanchanStatOf,
  totalAiMetrics,
  totalStats,
  type AiMetrics,
  type HanchanStat,
  type HanchanStatTotals,
  type MortalReport,
} from '@jantama/engine';

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
  /** その半荘の AI 一致率・類似度・悪手率（もとの数つき）。 */
  ai: AiMetrics;
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
  /** 数えた半荘をまとめた、AI 一致率・類似度・悪手率（もとの数つき）。数えた半荘が無ければ、数は 0、値は null。 */
  ai: AiMetrics;
  /** 悪手を数えた基準（確率。設定の「大きな不一致の基準」）。 */
  threshold: number;
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
  /** 悪手とする確率の基準（設定の「大きな不一致の基準」。出題・半荘のページと同じ値）。 */
  threshold: number;
}

export function buildImportedStats(input: ImportedStatsInput): ImportedWeekStats {
  const { sessions, summaries, gameState, week, threshold } = input;
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
    const report = state.status === 'ready' ? state.game.report : null;
    const stat = report === null ? null : statOf(report);
    if (report === null || stat === null) {
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
      ai: aiMetricsOf(report, { threshold }),
    });
  }
  return {
    imported: inWeek.length,
    loading,
    unreadable,
    rows,
    totals: totalStats(rows.map((row) => row.stat)),
    ai: totalAiMetrics(rows.map((row) => row.ai)),
    threshold,
  };
}
