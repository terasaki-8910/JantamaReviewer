import { describe, expect, it } from 'vitest';

import { type ImportedGame, importReportText } from '../src/import';
import { countMakaMoves, countMakaRecords, mortalTopAction, recordMakaMove } from '../src/maka';
import type { ActionEvent, ReportEntry } from '../src/report-types';
import { loadReportText } from './helpers/fixtures';

function entryWith(...actions: ActionEvent[]): Pick<ReportEntry, 'details'> {
  return { details: actions.map((action, i) => ({ action, q_value: 1 - i, prob: 0 })) };
}

const dahai = (pai: string): ActionEvent => ({ type: 'dahai', actor: 0, pai, tsumogiri: false });

describe('E-14 MAKA の打牌の記録', () => {
  it('E-14 MAKA の打牌が Mortal の1位と同じなら、同じと記録する', () => {
    const entry = entryWith(dahai('3m'), dahai('4m'));
    expect(recordMakaMove(entry, '3m')).toEqual({ move: '3m', equalsMortalTop: true });
  });

  it('E-14 違えば、食い違いと記録する（2位以下と同じでも1位と違えば食い違い）', () => {
    const entry = entryWith(dahai('3m'), dahai('4m'));
    expect(recordMakaMove(entry, '4m')).toEqual({ move: '4m', equalsMortalTop: false });
    expect(recordMakaMove(entry, 'E')).toEqual({ move: 'E', equalsMortalTop: false });
  });

  it('E-14 赤五と普通の五は同じ打牌として比べる', () => {
    expect(recordMakaMove(entryWith(dahai('5pr'), dahai('5p')), '5p').equalsMortalTop).toBe(true);
    expect(recordMakaMove(entryWith(dahai('5p'), dahai('5pr')), '5pr').equalsMortalTop).toBe(true);
    expect(recordMakaMove(entryWith(dahai('5p'), dahai('6p')), '6p').equalsMortalTop).toBe(false);
  });

  it('E-14 MAKA の打牌を入れなくても記録は作れる（答え合わせは進められる）', () => {
    const entry = entryWith(dahai('3m'));
    expect(recordMakaMove(entry)).toEqual({ move: null, equalsMortalTop: null });
    expect(recordMakaMove(entry, null)).toEqual({ move: null, equalsMortalTop: null });
    expect(recordMakaMove(entry, undefined)).toEqual({ move: null, equalsMortalTop: null });
  });

  it('E-14 Mortal の1位が打牌でない（リーチ・鳴き・スルーなど）ときは、打牌と比べられないので null', () => {
    expect(recordMakaMove(entryWith({ type: 'reach', actor: 0 }, dahai('7p')), '7p')).toEqual({ move: '7p', equalsMortalTop: null });
    expect(recordMakaMove(entryWith({ type: 'none' }, { type: 'pon', actor: 0, target: 1, pai: 'E', consumed: ['E', 'E'] }), 'E')).toEqual({
      move: 'E',
      equalsMortalTop: null,
    });
  });

  it('E-14 牌の表記として正しくない打牌は RangeError', () => {
    expect(() => recordMakaMove(entryWith(dahai('3m')), '0m')).toThrow(RangeError);
    expect(() => recordMakaMove(entryWith(dahai('3m')), 'x')).toThrow(RangeError);
  });

  it('E-14 Mortal の1位は候補の先頭', () => {
    expect(mortalTopAction(entryWith(dahai('3m'), dahai('4m')))).toEqual(dahai('3m'));
    expect(() => mortalTopAction({ details: [] })).toThrow(RangeError);
  });
});

describe('E-14 ログで数える', () => {
  it('E-14 記録の一覧を、入れた数・同じ・食い違い・入れていない・比べられないで数える', () => {
    const count = countMakaRecords([
      { move: '3m', equalsMortalTop: true },
      { move: '4m', equalsMortalTop: false },
      { move: '5m', equalsMortalTop: false },
      { move: null, equalsMortalTop: null },
      { move: '7p', equalsMortalTop: null },
    ]);
    expect(count).toEqual({ total: 5, entered: 4, notEntered: 1, equal: 1, different: 2, notComparable: 1 });
  });

  it('E-14 空の一覧は、すべて 0', () => {
    expect(countMakaRecords([])).toEqual({ total: 0, entered: 0, notEntered: 0, equal: 0, different: 0, notComparable: 0 });
  });

  it('E-14 判断の一覧（と入れた打牌）から、そのまま数えられる。入れていない判断があってもよい', () => {
    const items = [
      { entry: entryWith(dahai('3m'), dahai('4m')), makaMove: '3m' },
      { entry: entryWith(dahai('3m'), dahai('4m')), makaMove: '4m' },
      { entry: entryWith(dahai('3m'), dahai('4m')) },
      { entry: entryWith(dahai('3m'), dahai('4m')), makaMove: null },
    ];
    expect(countMakaMoves(items)).toEqual({ total: 4, entered: 2, notEntered: 2, equal: 1, different: 1, notComparable: 0 });
  });

  it('E-14 FX-1 の判断に MAKA の打牌を入れると、Mortal の1位との一致が記録される（実戦の取り込み結果で）', () => {
    const r = importReportText(loadReportText('f9da87cbcd7af5e9'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const game: ImportedGame = r.value;
    const discards = game.decisions.filter((d) => d.entry.details[0]?.action.type === 'dahai').slice(0, 10);
    expect(discards).toHaveLength(10);
    // MAKA が Mortal と同じ打牌を推した場合は全部「同じ」、別の牌なら全部「食い違い」
    const same = countMakaMoves(
      discards.map((d) => ({ entry: d.entry, makaMove: (d.entry.details[0]?.action as { pai: string }).pai })),
    );
    expect(same).toMatchObject({ total: 10, entered: 10, equal: 10, different: 0 });
    const other = countMakaMoves(
      discards.map((d) => {
        const top = (d.entry.details[0]?.action as { pai: string }).pai;
        return { entry: d.entry, makaMove: top === 'E' ? 'S' : 'E' };
      }),
    );
    expect(other).toMatchObject({ total: 10, entered: 10, equal: 0, different: 10 });
  });
});
