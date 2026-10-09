import { describe, expect, it } from 'vitest';

import { type SessionCandidate, type SessionMark, matchSessionForReport } from '../src/session-match';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX4_ID, loadFx4Ocr, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const report = load(FX4_ID);

/** FX-4 の迷いマーク6枚（5枚が読めて、1枚が読めない）をそのまま持つ半荘。 */
const fx4Marks: SessionMark[] = loadFx4Ocr().map((m) => ({ lines: m.lines }));

/** 局・点数だけの読み取り（残りの牌の数は省く）。 */
const at = (wind: 'E' | 'S' | 'W', number: number, score: number): SessionMark => ({ center: { wind, number, score } });

function session(id: string, started_ms: number | null | undefined, marks: SessionMark[]): SessionCandidate {
  return started_ms === undefined ? { id, marks } : { id, started_ms, marks };
}

describe('E-19 結びつける半荘（FX-4 の結果に対して）', () => {
  it('E-19 読めたスクショ（5枚）のすべてが結果と合う半荘が1つなら、その半荘に結びつく（読めない1枚は数えない）', () => {
    const result = matchSessionForReport(report, [session('20261009-190953', 1_000, fx4Marks)]);
    expect(result).toEqual({ kind: 'match', sessionId: '20261009-190953' });
  });

  it('E-19 局か点数が合わないスクショが1枚でもある半荘は合わない。合う半荘が1つだけなら、それに結びつく', () => {
    const wrongKyoku = session('other-1', 3_000, [at('S', 2, 25000), ...fx4Marks.slice(0, 2)]);
    const wrongScore = session('other-2', 4_000, [at('E', 2, 15000)]);
    const good = session('good', 1_000, fx4Marks);
    expect(matchSessionForReport(report, [wrongKyoku, good, wrongScore])).toEqual({ kind: 'match', sessionId: 'good' });
  });

  it('E-19 本場は点数で区別する: 東2局の 19000 点も 15100 点（東2局1本場）も、この結果に合う', () => {
    for (const [score, ok] of [
      [19000, true],
      [15100, true],
      [17000, false],
    ] as const) {
      const result = matchSessionForReport(report, [session('a', 1, [at('E', 2, score)]), session('b', 2, [at('S', 4, 1)])]);
      expect(result.kind, `${score}点`).toBe(ok ? 'match' : 'choose');
    }
  });

  it('E-19 合う半荘が2つ以上あるときは、選んでもらう（合う半荘だけを新しい順に返す）', () => {
    const oldGood = session('20261009-190953', 1_000, fx4Marks);
    const newGood = session('20261010-010000', 9_000, [at('E', 1, 25000)]);
    const bad = session('20261009-120000', 5_000, [at('W', 4, 25000)]);
    const result = matchSessionForReport(report, [oldGood, bad, newGood]);
    expect(result).toEqual({
      kind: 'choose',
      sessionIds: ['20261010-010000', '20261009-190953'],
      matchingIds: ['20261010-010000', '20261009-190953'],
    });
  });

  it('E-19 合う半荘が無いときは、結果の無い半荘すべてを新しい順に出して選んでもらう', () => {
    const a = session('a', 1_000, [at('S', 3, 25000)]);
    const b = session('b', 3_000, [at('W', 1, 25000)]);
    const c = session('c', 2_000, []);
    expect(matchSessionForReport(report, [a, b, c])).toEqual({ kind: 'choose', sessionIds: ['b', 'c', 'a'], matchingIds: [] });
  });

  it('E-19 結果の無い半荘が1つも無い（記録の無い半荘の結果）なら、新しい半荘にする', () => {
    expect(matchSessionForReport(report, [])).toEqual({ kind: 'new' });
  });

  it('E-19 読めたスクショが1枚も無い半荘（迷いも評価も読めない）は、合うとは言えない。ほかに合う半荘があればそちらに結びつく', () => {
    const unreadable = session('u', 9_000, [{ center: null }, { lines: ['00', '乙 局 8 0', '8 3 3 0', '、 一 3 詈 0'] }]);
    const empty = session('e', 8_000, []);
    expect(matchSessionForReport(report, [unreadable, empty])).toEqual({ kind: 'choose', sessionIds: ['u', 'e'], matchingIds: [] });
    expect(matchSessionForReport(report, [unreadable, empty, session('good', 1, fx4Marks)])).toEqual({ kind: 'match', sessionId: 'good' });
  });

  it('E-19 1枚だけ読めて合っていれば合う（読めない他のスクショは数えない）', () => {
    const one = session('one', 1, [{ center: null }, at('E', 3, 4400), { lines: [] }]);
    expect(matchSessionForReport(report, [one])).toEqual({ kind: 'match', sessionId: 'one' });
  });

  it('E-19 スクショは、読み取り済み（center）でも文字認識の行（lines）でもよい', () => {
    const byCenter = session('c', 1, [{ center: { wind: 'E', number: 3, tilesLeft: 46, score: 4400 } }]);
    const byLines = session('l', 2, [{ lines: ['0088 乙', '東 3 局', '个 4 6', '4400'] }]);
    expect(matchSessionForReport(report, [byCenter])).toEqual({ kind: 'match', sessionId: 'c' });
    expect(matchSessionForReport(report, [byLines])).toEqual({ kind: 'match', sessionId: 'l' });
    expect(matchSessionForReport(report, [byCenter, byLines])).toMatchObject({ kind: 'choose', sessionIds: ['l', 'c'] });
  });
});

describe('E-19 自分のリーチ棒の分を引いた点数（f9da87cbcd7af5e9）', () => {
  // 東2局は 25000 始まりで、残り33枚でリーチが成立する（本人は席1）
  const big = load('f9da87cbcd7af5e9');

  it('E-19 局の始めの点数から 1000 点引いた点数のスクショも、リーチのあった局なら合う', () => {
    expect(matchSessionForReport(big, [session('s', 1, [at('E', 2, 24000)])])).toEqual({ kind: 'match', sessionId: 's' });
    expect(matchSessionForReport(big, [session('s', 1, [at('E', 2, 25000)])])).toEqual({ kind: 'match', sessionId: 's' });
  });

  it('E-19 リーチの無い局では、1000 点引いた点数は合わない。引けるのは自分のリーチ1本だけ', () => {
    // 東1局（25000 始まり）はリーチ無し
    expect(matchSessionForReport(big, [session('s', 1, [at('E', 1, 24000)]), session('t', 2, [])]).kind).toBe('choose');
    expect(matchSessionForReport(big, [session('s', 1, [at('E', 2, 23000)]), session('t', 2, [])]).kind).toBe('choose');
  });

  it('E-19 残りの牌の数があれば、リーチが成立する前の画面で引いた点数は合わない（E-17 と同じ照合）', () => {
    const before: SessionMark = { center: { wind: 'E', number: 2, tilesLeft: 40, score: 24000 } };
    const after: SessionMark = { center: { wind: 'E', number: 2, tilesLeft: 20, score: 24000 } };
    expect(matchSessionForReport(big, [session('s', 1, [before]), session('t', 2, [])]).kind).toBe('choose');
    expect(matchSessionForReport(big, [session('s', 1, [after])])).toEqual({ kind: 'match', sessionId: 's' });
  });
});

describe('E-19 新しい順', () => {
  const marks = [at('E', 1, 25000)];

  it('E-19 最初の記録の時刻（started_ms）の新しい順に並べる', () => {
    const result = matchSessionForReport(report, [session('a', 100, marks), session('b', 300, marks), session('c', 200, marks)]);
    expect(result).toEqual({ kind: 'choose', sessionIds: ['b', 'c', 'a'], matchingIds: ['b', 'c', 'a'] });
  });

  it('E-19 時刻が無い半荘は、時刻のある半荘より後ろ。時刻が同じ・無いもの同士は名前の降順', () => {
    const result = matchSessionForReport(report, [
      session('20261009-100000', undefined, marks),
      session('20261010-100000', null, marks),
      session('old', 100, marks),
      session('tie-a', 500, marks),
      session('tie-b', 500, marks),
    ]);
    expect(result).toMatchObject({
      sessionIds: ['tie-b', 'tie-a', 'old', '20261010-100000', '20261009-100000'],
    });
  });

  it('E-19 渡した半荘の並びは書き換えない', () => {
    const sessions = [session('a', 100, marks), session('b', 300, marks)];
    const copy = [...sessions];
    matchSessionForReport(report, sessions);
    expect(sessions).toEqual(copy);
  });
});
