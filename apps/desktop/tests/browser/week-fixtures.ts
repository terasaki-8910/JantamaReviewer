/**
 * 週の集計の実ブラウザの検査（week.browser.test.ts）が使う、見本のデータ（試験のデータで、画面の部品ではない）。
 * 試験の「いま」は 2026 年 10 月 9 日（金）22:00。今週は 10 月 5 日（月）から。
 * 取り込んだ半荘は FX-4（今週。自分の〇△✕は △・✕・△・✕・✕、AI 基準は S+・S-・A・S・S-）と f9da（9 月 2 日）。答えは、直近 10 週に
 * 週ごと 3〜7 問。手で入れた成績・重点は、先週・2 週前・3 週前。
 */
import { actualChoice, keyOfDecision, type Decision, type ImportedGame } from '@jantama/engine';

import { REPORT_TEXTS, folderName, local, seedSession } from '../fake-sessions';
import { answerRow, gameOf } from '../fake-study';
import { fx4Ocr, fx4Session } from '../import-fixtures';
import { TINY_PNG, type Scenario } from './harness';

/** 試験の「いま」: 2026 年 10 月 9 日（金）22:00。今週は 10 月 5 日（月）から。 */
export const NOW = new Date(2026, 9, 9, 22, 0, 0);

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const baseSettings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
  daily_count: 5,
  disagreement_percent: 5,
  highlight_dora: false,
};

const FX4_AT = local(2026, 10, 9, 19, 9);
const FX4_ID = folderName(FX4_AT);
const FX1A_AT = local(2026, 9, 2, 17, 12);
const FX1A_ID = folderName(FX1A_AT);

const fx4 = gameOf('fx4');
const fx1a = gameOf('fx1a');

/** FX-4 の半荘（今週）。自分の〇△✕: △・✕・△・✕・✕。AI 基準は S+・S-・A・S・S-（A だけが△の帯で、あとは〇の帯）。 */
function fx4Imported() {
  const base = fx4Session(FX4_ID, FX4_AT, {
    report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
    ocr: fx4Ocr(),
    links: {
      marks: {},
      ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
      ratings_version: 99,
    },
  });
  const ratings = ['fair', 'bad', 'fair', 'bad', 'bad'] as const;
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

interface Pick {
  sessionId: string;
  game: ImportedGame;
  decision: Decision;
}

const picks = (sessionId: string, game: ImportedGame): Pick[] =>
  game.decisions.filter((d) => d.kind === 'discard').map((decision) => ({ sessionId, game, decision }));
const POOL = [...picks(FX4_ID, fx4).filter((_, i) => i % 7 === 0), ...picks(FX1A_ID, fx1a).filter((_, i) => i % 11 === 0)];

/** 週の月曜（10/5 から数えて、`back` 週前）。 */
const monday = (back: number) => new Date(2026, 9, 5 - 7 * back);

/**
 * 答えた問題: 直近 10 週。週ごとに 3〜7 問、原因・正解・出題と解き直しを混ぜる（図が、平らな線にならないように）。
 * 今週の原因は、受け入れ枚数が多い。
 */
function answers(): unknown[] {
  const rows: unknown[] = [];
  let id = 1;
  for (let back = 9; back >= 0; back -= 1) {
    const count = 3 + ((back * 2) % 5);
    for (let k = 0; k < count; k += 1) {
      const pick = POOL[(back * 5 + k) % POOL.length] as Pick;
      const day = monday(back);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (k % 5), 20, 10 + k).getTime();
      const causes = k % 3 === 0 ? ['ukeire', 'defense'] : k % 3 === 1 ? ['shape'] : back % 2 === 0 ? ['value', 'ukeire'] : [];
      rows.push(
        answerRow({
          id: id++,
          session_id: pick.sessionId,
          decision_key: keyOfDecision(pick.decision),
          mode: k % 4 === 3 ? 'review' : 'quiz',
          answered_at: at,
          choice: actualChoice(pick.decision),
          correct: (back + k) % 3 !== 0,
          causes,
          reason: '試験の理由',
        }),
      );
    }
  }
  return rows;
}

/** 手で入れた成績・重点（先週と 3 週前に成績、先週に重点）。 */
function weekRecords(): unknown[] {
  return [
    { week: '2026-09-14', stats: { rank4: 24.1, deal: 13.0, avg: 2.55, win: 20.9, call: 33.8, riichi: 18.1 }, focus: '' },
    { week: '2026-09-21', stats: { rank4: 22.8, deal: 12.4, avg: 2.5, win: 21.2, call: 32.9, riichi: 18.9 }, focus: '' },
    { week: '2026-09-28', stats: { rank4: 21.5, deal: 12.0, avg: 2.46, win: 21.8, call: 32.0, riichi: 19.4 }, focus: '押し引きは、リーチの現物から探す。\n2向聴は、受け入れを広く取る。' },
  ];
}

export interface ScenarioOptions {
  /** 今週だけの記録（答え・半荘が今週のものだけ。先週は、答えの無い週）。 */
  sparse?: boolean;
  weeks?: boolean;
}

export function scenario(options: ScenarioOptions = {}): Scenario {
  const sessions = options.sparse
    ? [fx4Imported()]
    : [fx4Imported(), seedSession(FX1A_AT, { id: FX1A_ID, report: 'fx1a' }).session];
  const reports: Record<string, string> = { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a };
  const all = answers() as Array<{ answered_at: number }>;
  const thisWeek = new Date(2026, 9, 5, 4, 0).getTime();
  return {
    label: 'main',
    state: baseState,
    settings: baseSettings,
    inputStatus: null,
    sessions,
    reports,
    thumb: TINY_PNG,
    answers: options.sparse ? all.filter((a) => a.answered_at >= thisWeek && (a as { session_id?: string }).session_id === FX4_ID) : all,
    weeks: options.weeks === false ? [] : options.sparse ? [] : weekRecords(),
  };
}
