import {
  actualChoice,
  calledTileOf,
  choiceText,
  findDecisionByKey,
  keyOfDecision,
  listProblems,
  replayFrames,
  sortTiles,
  splitKyokus,
  topChoice,
  type Decision,
  type Fuuro,
  type ImportedGame,
  type Tile,
} from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { local, seedSession } from '../../../tests/fake-sessions';
import { answerRow, gameOf } from '../../../tests/fake-study';
import type { AnswerRow, SessionRecord } from '../../api/types';
import type { Located } from '../study/StudyProvider';
import {
  FRESH_FILTER,
  buildLogRows,
  filterRows,
  hasFilter,
  inPeriod,
  latestAnswerPerProblem,
  summarize,
  weekStart,
  type LogFilter,
  type LogRow,
} from './logModel';

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';

const fx4 = gameOf('fx4');
const fx1a = gameOf('fx1a');
const sessions: Record<string, SessionRecord> = {
  [FX4_ID]: seedSession(local(2026, 10, 9, 19, 9, 53), { id: FX4_ID, report: 'fx4' }).session,
  [FX1A_ID]: seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
};
const games: Record<string, ImportedGame> = { [FX4_ID]: fx4, [FX1A_ID]: fx1a };

/** 消していない 2 つの半荘（FX-4 と f9da）から、判断を引く。 */
function locate(sessionId: string, key: string): Located | null {
  const session = sessions[sessionId];
  const game = games[sessionId];
  if (session === undefined || game === undefined) return null;
  const decision = findDecisionByKey(game, key);
  return decision === undefined ? null : { session, game, decision };
}

const NOW = local(2026, 10, 12, 12, 0);
const TODAY = '2026-10-12';

function answerFor(sessionId: string, decision: Decision, patch: Partial<AnswerRow> = {}): AnswerRow {
  return answerRow({
    session_id: sessionId,
    decision_key: keyOfDecision(decision),
    choice: actualChoice(decision),
    ...patch,
  });
}

function build(answers: AnswerRow[]) {
  return buildLogRows({ answers, locate, problems: [], now: NOW });
}

describe('U-29 週と期間（月曜から。日の境は午前 4 時）', () => {
  it('週は月曜から日曜: どの曜日も、その週の月曜になる（月・年をまたいでも）', () => {
    expect(weekStart('2026-10-12')).toBe('2026-10-12'); // 月
    expect(weekStart('2026-10-13')).toBe('2026-10-12'); // 火
    expect(weekStart('2026-10-18')).toBe('2026-10-12'); // 日
    expect(weekStart('2026-10-11')).toBe('2026-10-05'); // 日（前の週）
    expect(weekStart('2026-10-05')).toBe('2026-10-05');
    expect(weekStart('2026-11-01')).toBe('2026-10-26'); // 日、月をまたぐ
    expect(weekStart('2027-01-01')).toBe('2026-12-28'); // 金、年をまたぐ
    expect(() => weekStart('10/12')).toThrow(RangeError);
  });

  it('今週・先週・30日・すべて（今日が月曜のとき、先週は前の月曜から日曜）', () => {
    const today = '2026-10-12'; // 月曜
    expect(inPeriod('2026-10-12', 'week', today)).toBe(true);
    expect(inPeriod('2026-10-11', 'week', today)).toBe(false);
    expect(inPeriod('2026-10-11', 'last', today)).toBe(true);
    expect(inPeriod('2026-10-05', 'last', today)).toBe(true);
    expect(inPeriod('2026-10-04', 'last', today)).toBe(false);
    expect(inPeriod('2026-10-12', 'last', today)).toBe(false);
    // 30日 = 今日を入れて 30 日（今日から 29 日前まで）
    expect(inPeriod('2026-09-13', 'd30', today)).toBe(true);
    expect(inPeriod('2026-09-12', 'd30', today)).toBe(false);
    expect(inPeriod('2020-01-01', 'all', today)).toBe(true);
    // 今日が日曜のとき、今週は、その前の月曜から
    expect(inPeriod('2026-10-05', 'week', '2026-10-11')).toBe(true);
    expect(inPeriod('2026-10-04', 'week', '2026-10-11')).toBe(false);
  });

  it('答えた日は午前 4 時で替わる: 月曜の 3:59 の答えは日曜（先週の終わり）、4:00 の答えは月曜（今週の始め）', () => {
    const decision = fx4.decisions[10] as Decision;
    const before = answerFor(FX4_ID, decision, { id: 1, answered_at: local(2026, 10, 12, 3, 59) });
    const after = answerFor(FX4_ID, fx4.decisions[11] as Decision, { id: 2, answered_at: local(2026, 10, 12, 4, 0) });
    // 月曜の 12 時に見ているので、出題の「今日」は月曜
    const rows = build([before, after]);
    const byKey = new Map(rows.map((row) => [row.key, row] as const));
    expect(byKey.get(keyOfDecision(decision))?.date).toBe('2026-10-11');
    expect(byKey.get(keyOfDecision(fx4.decisions[11] as Decision))?.date).toBe('2026-10-12');
    const filter = (period: LogFilter['period']) => filterRows(rows, { ...FRESH_FILTER, period }, TODAY).map((row) => row.date);
    expect(filter('week')).toEqual(['2026-10-12']);
    expect(filter('last')).toEqual(['2026-10-11']);
    // 月曜の 3:30 に見ているときの「今日」は日曜（`studyDate`）なので、その日曜は今週
    const sundayRows = filterRows(rows, { ...FRESH_FILTER, period: 'week' }, '2026-10-11');
    expect(sundayRows.map((row) => row.date)).toEqual(['2026-10-12', '2026-10-11']);
  });
});

describe('U-29 行（問題ごとの、いちばん新しい答え）', () => {
  const first = fx4.decisions[10] as Decision;
  const second = fx4.decisions[20] as Decision;

  it('同じ問題の答えが何度あっても、行は 1 つ。いちばん新しい答え（出題でも解き直しでも）が行になる', () => {
    const answers = [
      answerFor(FX4_ID, first, { id: 1, answered_at: local(2026, 10, 9, 20, 0), mode: 'quiz', correct: false, due_date: '2026-10-10' }),
      answerFor(FX4_ID, first, { id: 2, answered_at: local(2026, 10, 12, 9, 0), mode: 'review', correct: true, due_date: '2026-10-19' }),
      answerFor(FX4_ID, first, { id: 3, answered_at: local(2026, 10, 10, 9, 0), mode: 'review', correct: false, due_date: '2026-10-11' }),
      answerFor(FX4_ID, second, { id: 4, answered_at: local(2026, 10, 11, 9, 0) }),
    ];
    expect(latestAnswerPerProblem(answers).map((row) => row.id).sort()).toEqual([2, 4]);
    const rows = build(answers);
    expect(rows).toHaveLength(2);
    // 新しく答えた順
    expect(rows.map((row) => row.answer.id)).toEqual([2, 4]);
    const row = rows[0] as LogRow;
    expect(row.mode).toBe('review');
    expect(row.correct).toBe(true);
    expect(row.nextDue).toBe('2026-10-19');
    expect(row.date).toBe('2026-10-12');
  });

  it('答えた時刻が同じなら、あとの答えが行になる', () => {
    const at = local(2026, 10, 11, 9, 0);
    const rows = build([
      answerFor(FX4_ID, first, { id: 1, answered_at: at, correct: false }),
      answerFor(FX4_ID, first, { id: 2, answered_at: at, correct: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.answer.id).toBe(2);
  });

  it('D-3: 消した半荘（一覧に無い半荘）と、結果を読めない半荘の問題は、行にならない', () => {
    const answers = [
      answerFor(FX4_ID, first, { id: 1 }),
      answerFor('20261001-120000', first, { id: 2 }), // 消した半荘
      answerFor(FX1A_ID, { ...(fx1a.decisions[3] as Decision) }, { id: 3, decision_key: 'k9h9e99' }), // 結果に無い判断
    ];
    const rows = build(answers);
    expect(rows.map((row) => row.sessionId)).toEqual([FX4_ID]);
  });

  it('行の中身: 局・巡目・半荘・種類・印・正誤・原因・原則・時間・選び直し・次の日。迷いの番号は問題の一覧から', () => {
    const decision = findDecisionByKey(fx4, 'k2h1e14') as Decision;
    const problems = listProblems(
      [{ sessionId: FX4_ID, startedMs: (sessions[FX4_ID] as SessionRecord).started_ms, game: fx4, markKeys: ['k2h1e14'] }],
      { threshold: 0.05 },
    );
    const answer = answerFor(FX4_ID, decision, {
      id: 7,
      mode: 'quiz',
      answered_at: local(2026, 10, 11, 23, 30),
      duration_ms: 62_000,
      reselect_count: 2,
      correct: false,
      causes: ['defense', 'ukeire'],
      principle: '  リーチが無いときは、受け入れを優先する  ',
      due_date: '2026-10-12',
    });
    const rows = buildLogRows({ answers: [answer], locate, problems, now: NOW });
    const row = rows[0] as LogRow;
    expect(row.title).toBe('東3局1本場 11巡目');
    expect(row.where).toBe('10月9日 19:09 の半荘');
    expect(row.kindName).toBe('打牌');
    expect(row.tags).toEqual(['1シャンテン']);
    expect(row.phases).toEqual(['1シャンテン']);
    expect(row.markNumber).toBe(1);
    expect(row.correct).toBe(false);
    expect(row.causeLabels).toEqual(['守備', '受け入れ枚数']);
    expect(row.principle).toBe('リーチが無いときは、受け入れを優先する');
    expect(row.seconds).toBe(62);
    expect(row.reselects).toBe(2);
    expect(row.nextDue).toBe('2026-10-12');
    expect(row.date).toBe('2026-10-11');
    expect(row.you).toBe(choiceText(decision, actualChoice(decision)));
    expect(row.actual).toMatch(/^打/);
    const top = topChoice(decision);
    expect(row.top).toBe(top === null ? '' : choiceText(decision, top));
  });

  it('局面と印: 2シャンテン以上・1シャンテン・聴牌は場面のシャンテン数から。鳴き・押し引き・序盤は判断のタグから（鳴きは種類に出るので、印には入れない）', () => {
    const rows = build(
      [...fx4.decisions, ...fx1a.decisions].map((decision, i) =>
        answerFor(fx4.decisions.includes(decision) ? FX4_ID : FX1A_ID, decision, { id: i + 1 }),
      ),
    );
    expect(rows).toHaveLength(fx4.decisions.length + fx1a.decisions.length);
    for (const row of rows) {
      const decision = (locate(row.sessionId, row.key) as Located).decision;
      expect(row.phases[0]).toBe(
        decision.shanten >= 2 ? '2シャンテン以上' : decision.shanten === 1 ? '1シャンテン' : '聴牌',
      );
      expect(row.phases.includes('鳴き')).toBe(decision.tags.includes('鳴き'));
      expect(row.phases.includes('押し引き')).toBe(decision.tags.includes('押し引き'));
      expect(row.phases.includes('序盤')).toBe(decision.tags.includes('序盤'));
      expect(row.tags).not.toContain('鳴き');
      expect(row.tags[0]).toBe(decision.shanten <= 0 ? '聴牌' : `${decision.shanten}シャンテン`);
      expect(row.kind === 'call').toBe(row.phases.includes('鳴き'));
    }
    // 実際に、どの局面も出てくる（絞り込みの試験が空振りしない）
    const seen = new Set(rows.flatMap((row) => row.phases));
    for (const phase of ['2シャンテン以上', '1シャンテン', '聴牌', '鳴き', '押し引き', '序盤']) expect(seen.has(phase as never), phase).toBe(true);
  });

  it('MAKA と食い違い: MAKA の打牌を入れていて、Mortal の1位と違うときだけ（同じ・入れていないは数えない）', () => {
    const decision = fx4.decisions.find((d) => d.kind === 'discard' && d.entry.details[0]?.action.type === 'dahai') as Decision;
    const top = decision.entry.details[0]?.action;
    if (top?.type !== 'dahai') throw new Error('打牌の1位が無い');
    const other = (decision.board.hand.find((t) => t.replace('r', '') !== top.pai.replace('r', '')) ?? '1m') as Tile;
    const rows = build([
      answerFor(FX4_ID, decision, { id: 1, maka_move: top.pai }),
      answerFor(FX4_ID, fx4.decisions[(decision.index + 1) % fx4.decisions.length] as Decision, { id: 2, maka_move: null }),
    ]);
    expect(rows.map((row) => row.makaDiffers)).toEqual([false, false]);
    const differs = build([answerFor(FX4_ID, decision, { id: 1, maka_move: other })]);
    expect(differs[0]?.makaDiffers).toBe(true);
  });
});

describe('U-29 絞り込み', () => {
  const answers = [...fx4.decisions.slice(0, 40).map((d, i) => answerFor(FX4_ID, d, { id: i + 1, answered_at: local(2026, 10, 12, 9, 0) + i * 1000, correct: i % 3 !== 0, causes: i % 4 === 0 ? ['ukeire', 'defense'] : i % 4 === 1 ? ['shape'] : [] })), ...fx1a.decisions.slice(0, 20).map((d, i) => answerFor(FX1A_ID, d, { id: 100 + i, answered_at: local(2026, 10, 7, 9, 0) + i * 1000, correct: i % 2 === 0, mode: 'review' }))];
  const rows = build(answers);

  it('期間: 今週は月曜から。先週と今週で、すべてが分かれる', () => {
    const week = filterRows(rows, { ...FRESH_FILTER, period: 'week' }, TODAY);
    const last = filterRows(rows, { ...FRESH_FILTER, period: 'last' }, TODAY);
    const all = filterRows(rows, { ...FRESH_FILTER, period: 'all' }, TODAY);
    expect(week).toHaveLength(40);
    expect(last).toHaveLength(20);
    expect(all).toHaveLength(60);
    expect(week.every((row) => row.sessionId === FX4_ID)).toBe(true);
    expect(last.every((row) => row.sessionId === FX1A_ID)).toBe(true);
  });

  it('同じ項目の中は「どれか」、項目どうしは「すべて」', () => {
    const all: LogFilter = { ...FRESH_FILTER, period: 'all' };
    const wrong = filterRows(rows, { ...all, results: ['wrong'] }, TODAY);
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.every((row) => !row.correct)).toBe(true);
    expect(filterRows(rows, { ...all, results: ['correct', 'wrong'] }, TODAY)).toHaveLength(rows.length);

    const ukeire = filterRows(rows, { ...all, causes: ['ukeire'] }, TODAY);
    expect(ukeire.length).toBeGreaterThan(0);
    expect(ukeire.every((row) => row.causes.includes('ukeire'))).toBe(true);
    const either = filterRows(rows, { ...all, causes: ['ukeire', 'shape'] }, TODAY);
    expect(either.length).toBeGreaterThan(ukeire.length);
    expect(either.every((row) => row.causes.includes('ukeire') || row.causes.includes('shape'))).toBe(true);

    const both = filterRows(rows, { ...all, causes: ['ukeire'], results: ['wrong'] }, TODAY);
    expect(both.length).toBeLessThan(Math.min(ukeire.length, wrong.length) + 1);
    expect(both.every((row) => row.causes.includes('ukeire') && !row.correct)).toBe(true);

    const calls = filterRows(rows, { ...all, kinds: ['call'] }, TODAY);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((row) => row.kind === 'call')).toBe(true);
    const tenpai = filterRows(rows, { ...all, phases: ['聴牌'] }, TODAY);
    expect(tenpai.every((row) => row.phases.includes('聴牌'))).toBe(true);
    const pushPull = filterRows(rows, { ...all, phases: ['押し引き', '序盤'] }, TODAY);
    expect(pushPull.every((row) => row.phases.includes('押し引き') || row.phases.includes('序盤'))).toBe(true);
  });

  it('skip: その項目だけ、かけない（メニューに、その項目を選んだときの数を出すため）', () => {
    const filter: LogFilter = { ...FRESH_FILTER, period: 'week', results: ['wrong'] };
    expect(filterRows(rows, filter, TODAY, 'results').length).toBeGreaterThan(filterRows(rows, filter, TODAY).length);
    // 期間をかけないと、先週の行（f9da）も入る
    expect(filterRows(rows, filter, TODAY).some((row) => row.sessionId === FX1A_ID)).toBe(false);
    expect(filterRows(rows, filter, TODAY, 'period').some((row) => row.sessionId === FX1A_ID)).toBe(true);
  });

  it('絞り込みがかかっているか（期間は数えない）', () => {
    expect(hasFilter(FRESH_FILTER)).toBe(false);
    expect(hasFilter({ ...FRESH_FILTER, period: 'all' })).toBe(false);
    expect(hasFilter({ ...FRESH_FILTER, kinds: ['call'] })).toBe(true);
    expect(hasFilter({ ...FRESH_FILTER, results: ['wrong'] })).toBe(true);
  });
});

describe('U-29 要約（絞り込んだ行の数と合う）', () => {
  it('問題の数・正解の割合（四捨五入）・答えるまでの平均・選び直した問題の数・MAKA と食い違った数', () => {
    const decisions = fx4.decisions.slice(0, 4);
    const top = (decisions[0] as Decision).entry.details[0]?.action;
    const makaOther = (['1m', '9s'] as const).find((t) => top?.type !== 'dahai' || t !== top.pai) ?? '1m';
    const rows = build([
      answerFor(FX4_ID, decisions[0] as Decision, { id: 1, correct: true, duration_ms: 30_000, reselect_count: 0 }),
      answerFor(FX4_ID, decisions[1] as Decision, { id: 2, correct: true, duration_ms: 45_000, reselect_count: 1 }),
      answerFor(FX4_ID, decisions[2] as Decision, { id: 3, correct: false, duration_ms: 75_000, reselect_count: 2, maka_move: makaOther }),
      answerFor(FX4_ID, decisions[3] as Decision, { id: 4, correct: false, duration_ms: 30_000, reselect_count: 0 }),
    ]);
    const summary = summarize(rows);
    expect(summary.count).toBe(4);
    expect(summary.correctPercent).toBe(50);
    expect(summary.averageSeconds).toBe(45);
    expect(summary.reselected).toBe(2);
    expect(summary.makaDiffers).toBe(rows.filter((row) => row.makaDiffers).length);
    // 絞り込んだ行から数える
    const wrong = filterRows(rows, { ...FRESH_FILTER, period: 'all', results: ['wrong'] }, TODAY);
    expect(summarize(wrong)).toMatchObject({ count: 2, correctPercent: 0, averageSeconds: 52.5, reselected: 1 });
    // 3 問中 2 問正解 = 66.67% → 67
    expect(summarize(rows.slice(0, 3).map((row, i) => ({ ...row, correct: i < 2 }))).correctPercent).toBe(67);
    // 行が無いとき
    expect(summarize([])).toEqual({ count: 0, correctPercent: null, averageSeconds: null, reselected: 0, makaDiffers: 0 });
  });
});

/** 副露を、順不同の牌を並べ替えた比べやすい文字列にする（取り込みの E-2 の突き合わせと同じ考え方）。 */
function meldKey(meld: Fuuro): string {
  const rest = meld.type === 'kakan' ? [meld.previous_pon_pai, meld.pai, ...meld.consumed] : [...meld.consumed, ...('pai' in meld ? [meld.pai] : [])];
  return `${meld.type}:${sortTiles(rest).join(' ')}`;
}

describe('U-29・E-2 行の手牌（再生と一致する）', () => {
  /** 判断ごとに、牌譜を別に再生した盤面（手牌・ツモ牌）。`Decision.board` を使わない。 */
  function replayedBoard(game: ImportedGame, decision: Decision) {
    const kyoku = splitKyokus(game.report.mjai_log)[decision.kyokuPosition];
    if (kyoku === undefined) throw new Error('局が無い');
    const frames = replayFrames(kyoku, game.playerId);
    const frame = frames[decision.eventIndex - kyoku.startIndex];
    if (frame === undefined) throw new Error('場面が無い');
    return frame.board;
  }

  it.each([
    ['FX-4', FX4_ID, fx4],
    ['f9da', FX1A_ID, fx1a],
  ] as const)('%s: すべての判断で、行の手牌 = 再生した手牌（記録の state と一致）、ツモ牌は分ける、鳴きの判断は鳴く牌を分ける', (_name, id, game) => {
    const rows = build(game.decisions.map((decision, i) => answerFor(id, decision, { id: i + 1 })));
    expect(rows).toHaveLength(game.decisions.length);
    for (const row of rows) {
      const decision = findDecisionByKey(game, row.key) as Decision;
      const label = `${row.title} ${row.key}`;
      const board = replayedBoard(game, decision);
      const items = row.hand.items;
      const closed = items.filter((item) => !item.called);
      // 手牌 + ツモ牌が、再生した手牌（並びも）と同じ
      expect(closed.filter((item) => !item.draw).map((item) => item.tile), label).toEqual([...board.hand]);
      expect(closed.filter((item) => item.draw).map((item) => item.tile), label).toEqual(board.drawn === null ? [] : [board.drawn]);
      // ツモ牌は最後の手牌のあと（手牌の途中に入らない）
      const drawAt = closed.findIndex((item) => item.draw);
      if (drawAt >= 0) expect(drawAt, label).toBe(closed.length - 1);
      // 記録（各判断の state）と、牌の集まりが一致する（E-2）
      expect(sortTiles(closed.map((item) => item.tile)), label).toEqual(sortTiles(decision.entry.state.tehai));
      // 副露も、再生した盤面・記録と同じ（鳴いた順）
      expect(row.hand.seat, label).toBe(game.playerId);
      expect(row.hand.melds, label).toEqual(board.melds[game.playerId]);
      expect(row.hand.melds.map(meldKey), label).toEqual(decision.entry.state.fuuros.map(meldKey));
      // 鳴きの判断: 鳴く牌（他家の打牌）が右端に 1 つ。打牌の判断・自分の手番の判断には無い
      const called = items.filter((item) => item.called);
      if (decision.kind !== 'discard' && calledTileOf(decision) !== null) {
        expect(called.map((item) => item.tile), label).toEqual([calledTileOf(decision)]);
        expect(items.at(-1)?.called, label).toBe(true);
        expect(row.hand.calledFrom, label).toMatch(/^(下家|対面|上家)$/);
      } else {
        expect(called, label).toEqual([]);
        expect(row.hand.calledFrom, label).toBeNull();
      }
    }
    // 副露のある判断が、実際にある（副露の突き合わせが空振りしない）
    expect(rows.some((row) => row.hand.melds.length > 0)).toBe(true);
    // 打牌の判断には、ツモ牌がある。鳴き（他家の打牌）の判断には無い
    const draws = rows.filter((row) => row.kind === 'discard' && row.hand.items.some((item) => item.draw));
    expect(draws.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.kind === 'call')).toBe(true);
  });
});
