/**
 * 問題と、今日の出題・解き直しの期限（E-24、E-25、F2・F7）。
 *
 * 問題は、取り込んだ半荘の判断のうち、次のどちらかに当たるもの（半荘の名前 `sessionId` と判断の鍵 `key` で 1 つに決まる）:
 * - 迷いの問題: 迷いマークを結びつけた判断（推定でも、ユーザーが選んだものでも。結びつけは、半荘のページと同じもの）
 * - 大きな不一致の問題: AI が実戦の行動に付けた確率が基準（既定 5%、設定）未満の判断（E-4）
 * 両方に当たる判断は、1 問（迷いの問題）として数える。同じ判断に迷いマークが 2 つ結びついていても 1 問（先の迷い）。
 *
 * 今日の出題は、まだ答えていない問題から、迷いの問題を先に（新しい半荘から、迷いの順に）入れ、残りを大きな不一致で
 * 確率の低い順（同じなら新しい半荘から）に入れて、1 日に出す数（既定 5）にする。作った組は、その日のうちは入れ替えない
 * （保存は Rust 側。ここは並びを決めるだけ）。消した半荘の問題は、呼ぶ側が渡さない。
 *
 * 解き直しは、答えた問題の最後の答えの期限が今日までのものを、期限の古い順に並べる。
 */
import type { Decision } from './decision';
import { decisionKey } from './decision-ref';
import type { ImportedGame } from './import';
import { actualProbability, DEFAULT_DISAGREEMENT_LIMIT, DEFAULT_DISAGREEMENT_THRESHOLD } from './disagreement';

/** 1 日に出す数の既定値（設定で変えられる）。 */
export const DEFAULT_DAILY_COUNT = DEFAULT_DISAGREEMENT_LIMIT;

export type ProblemKind = 'mark' | 'disagreement';

/** 問題を数える相手の半荘（結果を取り込んだもの）。 */
export interface ProblemSource {
  /** 半荘の名前（フォルダの名前）。 */
  sessionId: string;
  /** 半荘の始まりの時刻（ミリ秒。新しい半荘を先にするため）。 */
  startedMs: number;
  game: ImportedGame;
  /**
   * 迷いマークごとに、結びつけた判断の鍵（記録の順。迷いの番号は、この並びの位置 + 1）。
   * 結びつけが決まっていないもの（手で選ぶ必要があるもの）は null。
   */
  markKeys: ReadonlyArray<string | null>;
}

export interface Problem {
  sessionId: string;
  /** 判断の鍵（例: k2h1e14）。 */
  key: string;
  kind: ProblemKind;
  /** 迷いの問題のとき、何番目の迷いか（1 から）。 */
  markNumber: number | null;
  /** 半荘の始まりの時刻。 */
  startedMs: number;
  /** AI が実戦の行動に付けた確率。並べ替えにだけ使う（答える前の画面には出さない。U-1）。 */
  probability: number;
  decision: Decision;
}

/** 問題 1 つの識別（半荘の名前と判断の鍵）。 */
export interface ProblemRef {
  sessionId: string;
  key: string;
}

/** 問題の識別を 1 つの文字列にする（集合や表の鍵に使う）。 */
export function problemId(ref: ProblemRef): string {
  return `${ref.sessionId}/${ref.key}`;
}

/** 判断の鍵（局の通し番号・本場・局の中の判断の番号）。 */
export function keyOfDecision(decision: Pick<Decision, 'kyoku' | 'honba' | 'entryIndex'>): string {
  return decisionKey(decision.kyoku, decision.honba, decision.entryIndex);
}

/** 半荘の中から、鍵の判断を探す。無ければ undefined。 */
export function findDecisionByKey(game: ImportedGame, key: string): Decision | undefined {
  return game.decisions.find((d) => keyOfDecision(d) === key);
}

export interface ProblemOptions {
  /** この確率より低い行動を、大きな不一致とする（既定 0.05）。 */
  threshold?: number;
}

/**
 * 問題の一覧。並びは、今日の出題の並び（迷いの問題が先: 新しい半荘から、迷いの順。そのあと、大きな不一致: 確率の低い順、
 * 同じなら新しい半荘から、半荘の中の順）。答えたかどうかは見ない（呼ぶ側が、答えた問題を除く）。
 */
export function listProblems(sources: readonly ProblemSource[], options: ProblemOptions = {}): Problem[] {
  const threshold = options.threshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  const marks: Problem[] = [];
  const disagreements: Problem[] = [];
  for (const source of sources) {
    const byKey = new Map<string, Decision>();
    for (const d of source.game.decisions) byKey.set(keyOfDecision(d), d);
    const marked = new Set<string>();
    source.markKeys.forEach((key, index) => {
      if (key === null || marked.has(key)) return;
      const decision = byKey.get(key);
      if (decision === undefined) return;
      marked.add(key);
      marks.push({
        sessionId: source.sessionId,
        key,
        kind: 'mark',
        markNumber: index + 1,
        startedMs: source.startedMs,
        probability: actualProbability(decision.entry),
        decision,
      });
    });
    for (const decision of source.game.decisions) {
      const probability = actualProbability(decision.entry);
      const key = keyOfDecision(decision);
      if (probability >= threshold || marked.has(key)) continue;
      disagreements.push({
        sessionId: source.sessionId,
        key,
        kind: 'disagreement',
        markNumber: null,
        startedMs: source.startedMs,
        probability,
        decision,
      });
    }
  }
  const newerFirst = (a: Problem, b: Problem) => b.startedMs - a.startedMs;
  marks.sort((a, b) => newerFirst(a, b) || (a.markNumber ?? 0) - (b.markNumber ?? 0));
  disagreements.sort(
    (a, b) =>
      a.probability - b.probability || newerFirst(a, b) || a.decision.index - b.decision.index,
  );
  return [...marks, ...disagreements];
}

/**
 * 今日の出題の組を作る。`problems` は `listProblems` の並びのままで、`answered` は答えた問題の `problemId`。
 * まだ答えていない問題の先頭から `count` 問（既定 5）。
 */
export function buildDailySet(
  problems: readonly Problem[],
  answered: ReadonlySet<string>,
  count: number = DEFAULT_DAILY_COUNT,
): Problem[] {
  const size = Math.max(0, Math.floor(count));
  return problems.filter((p) => !answered.has(problemId(p))).slice(0, size);
}

/** 今日の組に入っていない、まだ答えていない問題（「残り」。並びは問題の並びのまま）。 */
export function restOfProblems(
  problems: readonly Problem[],
  answered: ReadonlySet<string>,
  daily: readonly ProblemRef[],
): Problem[] {
  const inDaily = new Set(daily.map(problemId));
  return problems.filter((p) => !answered.has(problemId(p)) && !inDaily.has(problemId(p)));
}

/** 答えの記録 1 件から、問題ごとの最後の答えを選ぶのに要る項目。 */
export interface AnswerLike extends ProblemRef {
  /** 答えた時刻（ミリ秒）。 */
  answeredAt: number;
  /** この答えのあとの、次の解き直しまでの間隔（日）。 */
  intervalDays: number;
  /** 次に解き直す日（YYYY-MM-DD）。 */
  dueDate: string;
}

/** 問題ごとの、最後の答え（答えた時刻が最も新しいもの。同じ時刻なら、あとのもの）。 */
export function latestAnswers<T extends AnswerLike>(answers: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const answer of answers) {
    const id = problemId(answer);
    const found = latest.get(id);
    if (found === undefined || answer.answeredAt >= found.answeredAt) latest.set(id, answer);
  }
  return [...latest.values()];
}

/**
 * 解き直しの期限が今日までの問題を、期限の古い順に返す（同じ期限なら、答えた時刻の古い順）。
 * `answers` は、問題ごとに最後の答えだけにしたもの（`latestAnswers`）。
 */
export function dueAnswers<T extends AnswerLike>(answers: readonly T[], today: string): T[] {
  return answers
    .filter((a) => a.dueDate <= today)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.answeredAt - b.answeredAt));
}
