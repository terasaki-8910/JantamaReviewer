/**
 * 検討ログ（F5、U-29、R11-11）の、画面に依存しない部分: 行の元になる値の組み立て・絞り込み・要約の数。純粋な関数だけ。
 *
 * - 行 = 答えた問題 1 つ（問題ごとの、いちばん新しい答え。出題でも解き直しでも）。消した半荘の問題（一覧に無い半荘）と、
 *   結果を読めない半荘の問題は、行にしない（D-3。出題・解き直し・検索と同じ）
 * - 答えた日は、午前 4 時までを前の日として数える（`studyDate`）。週は月曜から日曜
 * - 行の手牌は、出題の画面と同じ組み立て（`buildHandItems`）。判断の盤面は牌譜の再生（E-2）から作ってあるので、再生と一致する。
 *   ツモ牌は分けて、鳴きの判断では、鳴く牌（他家の打牌）を分けて持つ
 * - 絞り込み: 期間は 1 つ。種類・局面・原因・結果は、いくつでも（同じ項目の中は「どれか」、項目どうしは「すべて」）
 */
import {
  CAUSE_CHOICES,
  TAG_CALL,
  TAG_EARLY,
  TAG_PUSH_PULL,
  actualText,
  addDays,
  calledTileOf,
  choiceText,
  problemId,
  recordMakaMove,
  shantenTag,
  studyDate,
  topChoice,
  type CauseId,
  type DecisionKind,
  type Fuuro,
  type Problem,
  type Seat,
  type Tile,
} from '@jantama/engine';

import type { AnswerMode, AnswerRow } from '../../api/types';
import { formatSessionShort } from '../format';
import type { HandItem } from '../study/Hand';
import { buildHandItems } from '../study/handMarks';
import { KIND_NAME, relationName } from '../study/labels';
import type { Located } from '../study/StudyProvider';

// ---- 絞り込みの選択肢 ----

export type PeriodId = 'week' | 'last' | 'd30' | 'all';

export const PERIOD_CHOICES: ReadonlyArray<{ id: PeriodId; label: string }> = [
  { id: 'week', label: '今週' },
  { id: 'last', label: '先週' },
  { id: 'd30', label: '30日' },
  { id: 'all', label: 'すべて' },
];

/** 種類の選択肢（判断の種類。並びは、出題の画面と同じ）。 */
export const KIND_CHOICES: ReadonlyArray<{ id: DecisionKind; label: string }> = (
  ['discard', 'call', 'riichi', 'win', 'kan'] as const
).map((id) => ({ id, label: KIND_NAME[id] }));

/** 局面の選択肢。場面の向聴数（2・1・聴牌）と、判断のタグ（鳴き・押し引き・序盤）。 */
export const PHASE_CHOICES = [
  '2向聴以上',
  '1向聴',
  '聴牌',
  '鳴き',
  '押し引き',
  '序盤',
] as const;
export type LogPhase = (typeof PHASE_CHOICES)[number];

/** 原因の選択肢（答え合わせのあとに付ける、差の原因。エンジンの `CAUSE_CHOICES`）。 */
export const CAUSE_OPTIONS: ReadonlyArray<{ id: CauseId; label: string }> = CAUSE_CHOICES;

export type LogResult = 'correct' | 'wrong';

export const RESULT_CHOICES: ReadonlyArray<{ id: LogResult; label: string }> = [
  { id: 'correct', label: '正解' },
  { id: 'wrong', label: '不正解' },
];

export interface LogFilter {
  period: PeriodId;
  kinds: readonly DecisionKind[];
  phases: readonly LogPhase[];
  causes: readonly CauseId[];
  results: readonly LogResult[];
}

/** 最初の絞り込み（今週。ほかは、かけない）。 */
export const FRESH_FILTER: LogFilter = { period: 'week', kinds: [], phases: [], causes: [], results: [] };

/** 種類・局面・原因・結果のどれかがかかっているか（期間は数えない）。 */
export function hasFilter(filter: LogFilter): boolean {
  return filter.kinds.length > 0 || filter.phases.length > 0 || filter.causes.length > 0 || filter.results.length > 0;
}

// ---- 日付 ----

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** その日の週の月曜（YYYY-MM-DD）。週は月曜から日曜。 */
export function weekStart(date: string): string {
  const m = DAY_PATTERN.exec(date);
  if (m === null) throw new RangeError(`日付は YYYY-MM-DD です: ${JSON.stringify(date)}`);
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
  return addDays(date, -((day + 6) % 7));
}

/** 期間に入る日か。`today` は、出題の「今日」（午前 4 時までは前の日）。 */
export function inPeriod(date: string, period: PeriodId, today: string): boolean {
  switch (period) {
    case 'all':
      return true;
    case 'week':
      return date >= weekStart(today);
    case 'last': {
      const monday = weekStart(today);
      return date >= addDays(monday, -7) && date < monday;
    }
    case 'd30':
      return date >= addDays(today, -29);
  }
}

// ---- 行 ----

export interface HandPreview {
  /** 左から、手牌・ツモ牌・（鳴きの判断で）鳴く牌。出題の画面の手牌と同じ並び。 */
  items: readonly HandItem[];
  /** 他家の打牌への判断のとき、鳴く牌を打った人の呼び名（下家・対面・上家）。 */
  calledFrom: string | null;
  /** 本人の副露（鳴いた順）。手牌の右に、並べて出す。 */
  melds: readonly Fuuro[];
  /** 本人の席（副露の並べ方が、鳴いた相手の方向で決まる）。 */
  seat: Seat;
}

export interface LogRow {
  /** 問題の識別（半荘の名前と判断の鍵）。 */
  id: string;
  sessionId: string;
  key: string;
  /** その問題の、いちばん新しい答え。 */
  answer: AnswerRow;
  /** 答えた日（午前 4 時までは前の日。YYYY-MM-DD）。 */
  date: string;
  mode: AnswerMode;
  /** 局と巡目。例: 東3局1本場 11巡目。 */
  title: string;
  /** 「10月9日 19:09 の半荘」。 */
  where: string;
  kind: DecisionKind;
  kindName: string;
  /** 種類のあとに並べる印: 向聴数（聴牌）・押し引き・序盤。鳴きは、種類に出るので入れない。 */
  tags: readonly string[];
  /** 絞り込みの「局面」に当たるもの。 */
  phases: readonly LogPhase[];
  /** 迷いの問題のとき、何番目の迷いか。 */
  markNumber: number | null;
  correct: boolean;
  causes: readonly CauseId[];
  causeLabels: readonly string[];
  /** 学んだ原則（無ければ空）。 */
  principle: string;
  /** 答えるまでの時間（秒）。 */
  seconds: number;
  reselects: number;
  /** 次の解き直しの日（YYYY-MM-DD）。 */
  nextDue: string;
  /** MAKA の打牌を入れていて、Mortal の 1 位と食い違ったか。 */
  makaDiffers: boolean;
  hand: HandPreview;
  /** 「答えを出す」を入れたときだけ画面に出す 3 つ。自分の答え・実戦の行動・AI の 1 位（言い方。例: 打3m・東をポン）。 */
  you: string;
  actual: string;
  top: string;
}

export interface LogInput {
  answers: readonly AnswerRow[];
  /** 半荘の名前と判断の鍵から、半荘・再生した結果・判断を引く（消した半荘・読めない半荘・見つからない判断は null）。 */
  locate: (sessionId: string, key: string) => Located | null;
  /** 問題の一覧（迷いの番号を引く）。 */
  problems: readonly Problem[];
  /** 「10月9日 19:09」の年を省くか決める時刻（ミリ秒）。 */
  now?: number;
}

const CAUSE_LABEL: ReadonlyMap<string, string> = new Map(CAUSE_CHOICES.map((c) => [c.id, c.label]));

/** 局面。向聴数は場面の手で数えたもの（`Decision.shanten`）、鳴き・押し引き・序盤は判断のタグ。週の集計の「局面の種類」も、これで数える。 */
export function phasesOf(shanten: number, tags: readonly string[]): LogPhase[] {
  const phases: LogPhase[] = [shanten >= 2 ? '2向聴以上' : shanten === 1 ? '1向聴' : '聴牌'];
  if (tags.includes(TAG_CALL)) phases.push('鳴き');
  if (tags.includes(TAG_PUSH_PULL)) phases.push('押し引き');
  if (tags.includes(TAG_EARLY)) phases.push('序盤');
  return phases;
}

/** 画面に出す印: 向聴数（0 以下は聴牌）・押し引き・序盤。 */
function tagsOf(shanten: number, tags: readonly string[]): string[] {
  const shape = shanten <= 0 ? '聴牌' : shantenTag(shanten);
  return [shape, ...tags.filter((tag) => tag === TAG_PUSH_PULL || tag === TAG_EARLY)];
}

/** 問題ごとの、いちばん新しい答え（答えた時刻が最も新しいもの。同じ時刻なら、あとのもの）。 */
export function latestAnswerPerProblem(answers: readonly AnswerRow[]): AnswerRow[] {
  const latest = new Map<string, AnswerRow>();
  for (const row of answers) {
    const id = problemId({ sessionId: row.session_id, key: row.decision_key });
    const found = latest.get(id);
    if (found === undefined || row.answered_at >= found.answered_at) latest.set(id, row);
  }
  return [...latest.values()];
}

/** 行の手牌。判断の盤面（牌譜の再生から作った盤面）の、手牌・ツモ牌・鳴く牌と、副露。 */
export function handPreviewOf(decision: Located['decision']): HandPreview {
  const called: Tile | null = decision.kind === 'discard' ? null : calledTileOf(decision);
  const seat = decision.board.playerId;
  return {
    items: buildHandItems(decision.board, called),
    calledFrom: called === null ? null : relationName(seat, decision.entry.last_actor),
    melds: decision.board.melds[seat] ?? [],
    seat,
  };
}

/** 検討ログの行。新しく答えた順。 */
export function buildLogRows(input: LogInput): LogRow[] {
  const { answers, locate, problems } = input;
  const now = input.now ?? Date.now();
  const markNumbers = new Map(problems.map((p) => [problemId(p), p.markNumber] as const));
  const rows: LogRow[] = [];
  for (const answer of latestAnswerPerProblem(answers)) {
    const located = locate(answer.session_id, answer.decision_key);
    if (located === null) continue;
    const { decision, session } = located;
    const topPick = topChoice(decision);
    const makaRecord =
      answer.maka_move === null ? null : recordMakaMove(decision.entry, answer.maka_move as Tile);
    rows.push({
      id: problemId({ sessionId: answer.session_id, key: answer.decision_key }),
      sessionId: answer.session_id,
      key: answer.decision_key,
      answer,
      date: studyDate(new Date(answer.answered_at)),
      mode: answer.mode,
      title: `${decision.kyokuLabel} ${decision.junme}巡目`,
      where: `${formatSessionShort(session.started_ms, now)} の半荘`,
      kind: decision.kind,
      kindName: KIND_NAME[decision.kind],
      tags: tagsOf(decision.shanten, decision.tags),
      phases: phasesOf(decision.shanten, decision.tags),
      markNumber: markNumbers.get(problemId({ sessionId: answer.session_id, key: answer.decision_key })) ?? null,
      correct: answer.correct,
      causes: answer.causes as CauseId[],
      causeLabels: answer.causes.map((id) => CAUSE_LABEL.get(id) ?? id),
      principle: answer.principle.trim(),
      seconds: answer.duration_ms / 1000,
      reselects: answer.reselect_count,
      nextDue: answer.due_date,
      makaDiffers: makaRecord !== null && makaRecord.equalsMortalTop === false,
      hand: handPreviewOf(decision),
      you: choiceText(decision, answer.choice),
      actual: actualText(decision),
      top: topPick === null ? '' : choiceText(decision, topPick),
    });
  }
  rows.sort((a, b) => b.answer.answered_at - a.answer.answered_at || b.answer.id - a.answer.id);
  return rows;
}

// ---- 絞り込み ----

type MultiGroup = 'kinds' | 'phases' | 'causes' | 'results';

/** 行が、その項目の選択のどれかに当たるか（選んでいなければ、当たる）。 */
function hitsGroup(row: LogRow, filter: LogFilter, group: MultiGroup): boolean {
  switch (group) {
    case 'kinds':
      return filter.kinds.length === 0 || filter.kinds.includes(row.kind);
    case 'phases':
      return filter.phases.length === 0 || filter.phases.some((phase) => row.phases.includes(phase));
    case 'causes':
      return filter.causes.length === 0 || filter.causes.some((cause) => row.causes.includes(cause));
    case 'results':
      return filter.results.length === 0 || filter.results.includes(row.correct ? 'correct' : 'wrong');
  }
}

/** 絞り込みをかける。`skip` の項目は、かけない（メニューに、その項目を選んだときの数を出すため）。 */
export function filterRows(
  rows: readonly LogRow[],
  filter: LogFilter,
  today: string,
  skip?: keyof LogFilter,
): LogRow[] {
  return rows.filter(
    (row) =>
      (skip === 'period' || inPeriod(row.date, filter.period, today)) &&
      (['kinds', 'phases', 'causes', 'results'] as const).every((group) => skip === group || hitsGroup(row, filter, group)),
  );
}

// ---- 要約 ----

export interface LogSummary {
  /** 問題の数。 */
  count: number;
  /** 正解の割合（%。四捨五入）。行が無ければ null。 */
  correctPercent: number | null;
  /** 答えるまでの平均（秒）。行が無ければ null。 */
  averageSeconds: number | null;
  /** 答えを選び直した問題の数。 */
  reselected: number;
  /** MAKA と食い違った問題の数。 */
  makaDiffers: number;
}

export function summarize(rows: readonly LogRow[]): LogSummary {
  const count = rows.length;
  if (count === 0) return { count, correctPercent: null, averageSeconds: null, reselected: 0, makaDiffers: 0 };
  const correct = rows.filter((row) => row.correct).length;
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  return {
    count,
    correctPercent: Math.round((correct / count) * 100),
    averageSeconds: total / count,
    reselected: rows.filter((row) => row.reselects > 0).length,
    makaDiffers: rows.filter((row) => row.makaDiffers).length,
  };
}
