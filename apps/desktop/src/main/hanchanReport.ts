/**
 * 半荘のページが使う、取り込んだ結果（report.json）の読み込み。
 *
 * 半荘の一覧の行に出す卓・段階・Rating は、半荘ごとに 1 回ずつ読む `SummaryStore`（sessionSummaries.ts）が持つ。
 * 結果そのもの（迷いの結びつけ・局の評価の表に使う、牌譜つきの大きなもの）は、全部の半荘ぶんを覚えておくと重いので、
 * いま見ている半荘の分だけ、ここで読む。
 */
import { useEffect, useState } from 'react';
import { parseReportText, type MortalReport } from '@jantama/engine';

import { api, errorMessage } from '../api/tauri';

export type ReportState =
  /** まだ取り込んでいない。 */
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; report: MortalReport }
  | { status: 'unavailable'; reason: string };

async function loadReport(sessionId: string): Promise<ReportState> {
  try {
    const text = await api.readReport(sessionId);
    if (typeof text !== 'string' || text === '') {
      return { status: 'unavailable', reason: '取り込んだ結果を読み出せませんでした' };
    }
    const parsed = parseReportText(text);
    if (!parsed.ok) return { status: 'unavailable', reason: parsed.error.message };
    return { status: 'ready', report: parsed.value };
  } catch (error) {
    return { status: 'unavailable', reason: errorMessage(error) };
  }
}

/**
 * 半荘の取り込んだ結果。`reportPath` が null（取り込み前）なら `none`。
 * 半荘の名前か結果の場所が変わったら、読み直す（同じなら、一覧が読み直されても、読み直さない）。
 */
export function useSessionReport(sessionId: string, reportPath: string | null): ReportState {
  const key = reportPath === null ? null : `${sessionId}\n${reportPath}`;
  const [loaded, setLoaded] = useState<{ key: string; state: ReportState } | null>(null);

  useEffect(() => {
    if (key === null) return undefined;
    let alive = true;
    void loadReport(sessionId).then((state) => {
      if (alive) setLoaded({ key, state });
    });
    return () => {
      alive = false;
    };
  }, [key, sessionId]);

  if (key === null) return { status: 'none' };
  return loaded?.key === key ? loaded.state : { status: 'loading' };
}
