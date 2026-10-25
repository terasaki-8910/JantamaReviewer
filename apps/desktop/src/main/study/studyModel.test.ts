import { problemId } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { answerRow, gameOf } from '../../../tests/fake-study';
import { local, seedSession } from '../../../tests/fake-sessions';
import { FX5_ID, FX5_STARTED, FX5_USER_CHOICES, fx4Ocr, fx4Session, fx5Ocr, fx5Session } from '../../../tests/import-fixtures';
import type { AnswerRow, SessionRecord } from '../../api/types';
import type { GameMap } from './gameStore';
import { answeredIds, buildStudyModel, collectProblems, plannedSet } from './studyModel';

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';

/** FX-4（読み取りの写しつき。迷い 1〜5 は推定、迷い 6 は読めない）と、f9da（迷いなし）。 */
function sessions(): SessionRecord[] {
  return [
    fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: 'C:\\data\\fx4\\report.json', ocr: fx4Ocr() }),
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
  ];
}

function games(ids: string[] = [FX4_ID, FX1A_ID]): GameMap {
  const all: Record<string, ReturnType<typeof gameOf>> = { [FX4_ID]: gameOf('fx4'), [FX1A_ID]: gameOf('fx1a') };
  return new Map(ids.map((id) => [id, { status: 'ready' as const, game: all[id] as ReturnType<typeof gameOf> }]));
}

describe('E-24 問題と今日の組（画面が使う組み立て）', () => {
  const collected = collectProblems(sessions(), games());

  it('問題 = 迷いに結びついた判断と、悪手。両方に当たるものは 1 問（迷いのほう）', () => {
    const marks = collected.problems.filter((problem) => problem.kind === 'mark');
    // FX-4: 迷い 1〜5 が推定で結びつく。迷い 6 は読めない（決まっていない）
    // 並びは、細かいミス（迷い 2。実戦は打8p、AI の1位は打9p）が先頭で、あとは迷いの順（E-46）
    expect(marks.map((problem) => problem.markNumber)).toEqual([2, 1, 3, 4, 5]);
    expect(collected.undecided).toBe(1);
    const ids = collected.problems.map((problem) => problemId(problem));
    expect(new Set(ids).size).toBe(ids.length);
    // FX-4 の不一致 5 件のうち、迷いに当たる 1 件を除いた 4 件と、f9da の 19 件が、不一致の問題
    expect(collected.problems.filter((problem) => problem.kind === 'disagreement')).toHaveLength(4 + 19);
  });

  it('今日の組: 迷いの問題を先に（細かいミス、ほかの迷いの順）。1 日に出す数まで', () => {
    const planned = plannedSet(collected.problems, [], 5);
    expect(planned).toHaveLength(5);
    expect(planned.every((ref) => ref.session_id === FX4_ID)).toBe(true);
    const marked = collected.problems.filter((problem) => problem.kind === 'mark');
    expect(planned.map((ref) => ref.decision_key)).toEqual(marked.map((problem) => problem.key));
    // 数を替えると、その数だけ
    expect(plannedSet(collected.problems, [], 3)).toHaveLength(3);
    expect(plannedSet(collected.problems, [], 12)).toHaveLength(12);
  });

  it('組は、まだ答えていない問題だけから作る（答えた問題は入れない）', () => {
    const first = collected.problems[0];
    if (first === undefined) throw new Error('問題が無い');
    const answered = [answerRow({ session_id: first.sessionId, decision_key: first.key })];
    const planned = plannedSet(collected.problems, answered, 5);
    expect(planned.map((ref) => ref.decision_key)).not.toContain(first.key);
    expect(answeredIds(answered)).toEqual(new Set([problemId(first)]));
  });
});

describe('U-15 今日の出題の画面のデータ', () => {
  const collected = collectProblems(sessions(), games());
  const daily = plannedSet(collected.problems, [], 5);
  const base = { sessions: sessions(), games: games(), answers: [] as AnswerRow[], threshold: 0.05, daily, today: '2026-10-09' };

  it('保存してある組を、そのままの順で並べる。まだ答えていない数と、「残り」と、結びつけが決まっていない迷いの数', () => {
    const model = buildStudyModel(base, collected);
    expect(model.today.items.map((item) => item.problem.key)).toEqual(daily.map((ref) => ref.decision_key));
    expect(model.today.items.every((item) => item.answer === null)).toBe(true);
    expect(model.today.answered).toBe(0);
    expect(model.today.unanswered).toBe(5);
    expect(model.today.sessionCount).toBe(1);
    expect(model.today.undecidedMarks).toBe(1);
    // 残りは、組に入っていない問題（FX-4 の不一致 4 件と f9da の 19 件）
    expect(model.today.rest).toHaveLength(4 + 19);
    expect(model.due).toEqual([]);
    expect(model.nextDue).toBeNull();
  });

  it('組がまだ無いとき（これから作る）は、空の組。残りは、答えていない問題すべて', () => {
    const model = buildStudyModel({ ...base, daily: null }, collected);
    expect(model.today.items).toEqual([]);
    expect(model.today.rest).toHaveLength(collected.problems.length);
  });

  it('出題で答えた問題は「解答済み」になり、数が減る。残りから答えた問題（追加で解いた分）は、残りから消える', () => {
    const [first] = daily;
    const extra = collected.problems.find((problem) => problem.kind === 'disagreement');
    if (first === undefined || extra === undefined) throw new Error('問題が無い');
    const answers = [
      answerRow({ id: 1, session_id: first.session_id, decision_key: first.decision_key, mode: 'quiz' }),
      answerRow({ id: 2, session_id: extra.sessionId, decision_key: extra.key, mode: 'quiz', due_date: '2026-10-10' }),
    ];
    const model = buildStudyModel({ ...base, answers }, collected);
    expect(model.today.answered).toBe(1);
    expect(model.today.unanswered).toBe(4);
    expect(model.today.items[0]?.answer?.id).toBe(1);
    expect(model.today.rest.map((problem) => problem.key)).not.toContain(extra.key);
    expect(model.today.rest).toHaveLength(4 + 19 - 1);
  });

  it('消した半荘（一覧に無い半荘）の問題は、組にも残りにも解き直しにも出ない', () => {
    const kept = sessions().filter((session) => session.id === FX1A_ID);
    const model = buildStudyModel(
      {
        ...base,
        sessions: kept,
        games: games([FX1A_ID]),
        answers: [answerRow({ session_id: FX4_ID, decision_key: daily[0]?.decision_key ?? 'k0h0e0' })],
      },
      collectProblems(kept, games([FX1A_ID])),
    );
    expect(model.today.items).toEqual([]);
    expect(model.today.rest.every((problem) => problem.sessionId === FX1A_ID)).toBe(true);
    expect(model.due).toEqual([]);
    expect(model.nextDue).toBeNull();
  });

  it('結果を読み出せない半荘（再生できない）の問題は出さない', () => {
    const map: GameMap = new Map([
      [FX4_ID, { status: 'unavailable' as const, reason: '試験' }],
      [FX1A_ID, { status: 'ready' as const, game: gameOf('fx1a') }],
    ]);
    const model = buildStudyModel({ ...base, games: map, daily: null }, collectProblems(sessions(), map));
    expect(model.problems.every((problem) => problem.sessionId === FX1A_ID)).toBe(true);
  });
});

describe('E-25 解き直しの期限', () => {
  const collected = collectProblems(sessions(), games());
  const a = collected.problems[0];
  const b = collected.problems[1];
  const c = collected.problems[2];
  if (a === undefined || b === undefined || c === undefined) throw new Error('問題が足りない');
  const base = { sessions: sessions(), games: games(), threshold: 0.05, daily: null, today: '2026-10-09' };

  it('問題ごとの最後の答えの期限が、今日までのものを、期限の古い順に並べる', () => {
    const answers = [
      answerRow({ id: 1, session_id: a.sessionId, decision_key: a.key, due_date: '2026-10-09', interval_days: 3, answered_at: 10 }),
      answerRow({ id: 2, session_id: b.sessionId, decision_key: b.key, due_date: '2026-10-07', interval_days: 1, answered_at: 11 }),
      answerRow({ id: 3, session_id: c.sessionId, decision_key: c.key, due_date: '2026-10-12', interval_days: 7, answered_at: 12 }),
    ];
    const model = buildStudyModel({ ...base, answers }, collected);
    expect(model.due.map((entry) => entry.key)).toEqual([b.key, a.key]);
    expect(model.due[0]?.answer.id).toBe(2);
    expect(model.due[0]?.answer.interval_days).toBe(1);
    // 今日より先で、いちばん近い日
    expect(model.nextDue).toBe('2026-10-12');
  });

  it('同じ問題を解き直したら、最後の答えの期限で決まる（古い答えの期限は、もう使わない）', () => {
    const answers = [
      answerRow({ id: 1, session_id: a.sessionId, decision_key: a.key, due_date: '2026-10-08', answered_at: 10 }),
      answerRow({ id: 2, session_id: a.sessionId, decision_key: a.key, mode: 'review', due_date: '2026-10-16', interval_days: 7, answered_at: 20 }),
    ];
    const model = buildStudyModel({ ...base, answers }, collected);
    expect(model.due).toEqual([]);
    expect(model.nextDue).toBe('2026-10-16');
  });

  it('期限の日（今日）の問題も出る。答えの記録が無ければ、何も出ない', () => {
    const today = buildStudyModel(
      { ...base, answers: [answerRow({ session_id: a.sessionId, decision_key: a.key, due_date: '2026-10-09' })] },
      collected,
    );
    expect(today.due).toHaveLength(1);
    expect(buildStudyModel({ ...base, answers: [] }, collected).due).toEqual([]);
  });
});

describe('E-24 問題の数え方（局だけ分かった迷い・崩れた読み取りの推定。FX-5）', () => {
  const fx5 = (marks: Record<string, string> = {}): SessionRecord =>
    fx5Session(FX5_ID, FX5_STARTED, {
      report_path: 'C:/data/fx5/report.json',
      ocr: fx5Ocr(),
      links: { marks, ratings: {} },
    });
  const fx5Games = (): GameMap => new Map([[FX5_ID, { status: 'ready' as const, game: gameOf('fx5') }]]);

  it('局だけ分かった迷い（15:38:10・15:42:37）は、判断を選ぶまで、決まっていない迷いとして数え、問題に入れない。崩れた読み取りの推定は、推定と同じに問題になる', () => {
    const collected = collectProblems([fx5()], fx5Games());
    const marks = collected.problems.filter((problem) => problem.kind === 'mark');
    // 迷い 13 のうち、局だけ分かった 2 つ（迷いの番号 3・5）を除いた 11 が、問題になる
    // 並びは、細かいミス（迷い 1・4・7・8・9・11・12）が先、ほかの迷い（迷い 2・6・10・13）があと。それぞれ迷いの順（E-46）
    expect(marks.map((problem) => problem.markNumber)).toEqual([1, 4, 7, 8, 9, 11, 12, 2, 6, 10, 13]);
    expect(collected.undecided).toBe(2);
    // 崩れた読み取りの推定（15:37:02 の 5巡目の打6s、15:50:36 の 3巡目の打1s、16:03:19 の 6巡目のリーチ）も、問題になる
    expect(marks.filter((problem) => [1, 8, 13].includes(problem.markNumber ?? 0)).map((problem) => problem.key)).toEqual(['k1h0e5', 'k4h2e2', 'k7h0e6']);
  });

  it('局だけ分かった迷いを、判断を選ぶと、その判断が問題になり、決まっていない迷いは減る', () => {
    // 15:38:10（迷いの id 4）に、ユーザーが選んだ 東2局8巡目の打9m（k1h0e8）を結びつける
    const collected = collectProblems([fx5({ '4': 'k1h0e8' })], fx5Games());
    const marks = collected.problems.filter((problem) => problem.kind === 'mark');
    expect(marks.map((problem) => problem.markNumber)).toContain(3);
    expect(marks.find((problem) => problem.markNumber === 3)?.key).toBe('k1h0e8');
    expect(collected.undecided).toBe(1);
    // ユーザーが選んだ 7 つ（ACCEPTANCE の FX-5）をすべて結びつけると、決まっていない迷いは 0
    expect(collectProblems([fx5({ ...FX5_USER_CHOICES })], fx5Games()).undecided).toBe(0);
  });
});

describe('E-45 解決した問題（F16）', () => {
  const collected = collectProblems(sessions(), games());
  const daily = plannedSet(collected.problems, [], 5);
  const base = { sessions: sessions(), games: games(), answers: [] as AnswerRow[], threshold: 0.05, daily, today: '2026-10-09' };
  const idOf = (key: string) => problemId({ sessionId: FX4_ID, key });

  it('組を新しく作るときは、解決した問題を入れない（足りない分は、次の問題で埋める）', () => {
    const first = daily[0];
    if (first === undefined) throw new Error('組が無い');
    const planned = plannedSet(collected.problems, [], 5, new Set([idOf(first.decision_key)]));
    expect(planned).toHaveLength(5);
    expect(planned.map((ref) => ref.decision_key)).not.toContain(first.decision_key);
    // 迷いの 4 つが先、そのあとに悪手が 1 つ
    expect(planned.slice(0, 4).map((ref) => ref.decision_key)).toEqual(daily.slice(1).map((ref) => ref.decision_key));
  });

  it('保存してある組は変えず、解決した問題に印を付ける。解いていない数・解決しただけの数・残りは、解決を除く', () => {
    const resolved = new Set([idOf(daily[0]?.decision_key ?? ''), idOf(daily[2]?.decision_key ?? '')]);
    const restProblem = collected.problems.find((problem) => problem.kind === 'disagreement');
    if (restProblem === undefined) throw new Error('問題が無い');
    resolved.add(problemId(restProblem));
    const model = buildStudyModel({ ...base, resolved }, collected);
    expect(model.today.items.map((item) => item.problem.key)).toEqual(daily.map((ref) => ref.decision_key));
    expect(model.today.items.map((item) => item.resolved)).toEqual([true, false, true, false, false]);
    expect(model.today.unanswered).toBe(3);
    expect(model.today.resolvedOnly).toBe(2);
    expect(model.today.answered).toBe(0);
    // 残りにも出さない
    expect(model.today.rest.map((problem) => problem.key)).not.toContain(restProblem.key);
    expect(model.today.rest).toHaveLength(4 + 19 - 1);
    // 解決が無ければ、どれも印は無い
    const none = buildStudyModel(base, collected);
    expect(none.today.items.some((item) => item.resolved)).toBe(false);
    expect(none.today.resolvedOnly).toBe(0);
  });

  it('答えた問題を解決しても、答えたまま。解いていない数にも、解決しただけの数にも入らない', () => {
    const first = daily[0];
    if (first === undefined) throw new Error('組が無い');
    const answers = [answerRow({ id: 1, session_id: first.session_id, decision_key: first.decision_key, mode: 'quiz' })];
    const model = buildStudyModel({ ...base, answers, resolved: new Set([idOf(first.decision_key)]) }, collected);
    expect(model.today.items[0]).toMatchObject({ resolved: true });
    expect(model.today.items[0]?.answer?.id).toBe(1);
    expect(model.today.answered).toBe(1);
    expect(model.today.unanswered).toBe(4);
    expect(model.today.resolvedOnly).toBe(0);
  });

  it('解き直しの列から外し、「次の解き直し」の日にも数えない。解決を切ると、元の期限で戻る', () => {
    const a = collected.problems[0];
    const b = collected.problems[1];
    const c = collected.problems[2];
    if (a === undefined || b === undefined || c === undefined) throw new Error('問題が足りない');
    const answers = [
      answerRow({ id: 1, session_id: a.sessionId, decision_key: a.key, due_date: '2026-10-09', answered_at: 10 }),
      answerRow({ id: 2, session_id: b.sessionId, decision_key: b.key, due_date: '2026-10-07', answered_at: 11 }),
      answerRow({ id: 3, session_id: c.sessionId, decision_key: c.key, due_date: '2026-10-12', answered_at: 12 }),
    ];
    const input = { ...base, daily: null, answers };
    expect(buildStudyModel(input, collected).due.map((entry) => entry.key)).toEqual([b.key, a.key]);
    const resolved = new Set([problemId(b), problemId(c)]);
    const model = buildStudyModel({ ...input, resolved }, collected);
    expect(model.due.map((entry) => entry.key)).toEqual([a.key]);
    expect(model.nextDue).toBeNull();
    // 切ると、元の期限のまま戻る
    const back = buildStudyModel({ ...input, resolved: new Set() }, collected);
    expect(back.due.map((entry) => entry.key)).toEqual([b.key, a.key]);
    expect(back.due[0]?.answer.due_date).toBe('2026-10-07');
    expect(back.nextDue).toBe('2026-10-12');
  });
});

describe('E-46・E-49 細かいミスと悪手の問題', () => {
  it('迷いの問題は、細かいミスが先頭（新しい半荘から、迷いの順）。細かいミスかどうかが、問題に入っている', () => {
    const collected = collectProblems(sessions(), games());
    const marks = collected.problems.filter((problem) => problem.kind === 'mark');
    expect(marks.map((problem) => [problem.markNumber, problem.fineMiss])).toEqual([
      [2, true],
      [1, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(collected.problems.filter((problem) => problem.kind !== 'mark').every((problem) => !problem.fineMiss)).toBe(true);
  });

  it('今日の出題は、細かいミス → ほかの迷い → 悪手の順', () => {
    const kinds = collectProblems(sessions(), games()).problems.map((problem) =>
      problem.kind === 'disagreement' ? 'bad-move' : problem.fineMiss ? 'fine-miss' : 'doubt',
    );
    expect(kinds).toEqual([...kinds].sort((a, b) => ['fine-miss', 'doubt', 'bad-move'].indexOf(a) - ['fine-miss', 'doubt', 'bad-move'].indexOf(b)));
  });
});


