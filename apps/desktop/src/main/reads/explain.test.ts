import { tileKind } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import { EMPTY_WAITS, fx4Reads, moment, opponent } from '../../../tests/reads-fixtures';
import { defenseAgainst, riichiOpponentSeats } from './defense';
import { barRatio, cellLabel, chipText, explainTile, percentOf, STRONG_FROM, tenpaiChips, tenpaiLineItems, wasReread } from './explain';

describe('F23 数の丸め方', () => {
  it('整数の %。0.5% 未満は 0、ちょうど 0.5% は 1（四捨五入）。100% を超えない', () => {
    expect(percentOf(0)).toBe(0);
    expect(percentOf(0.0049)).toBe(0);
    expect(percentOf(0.005)).toBe(1);
    expect(percentOf(0.1234)).toBe(12);
    expect(percentOf(0.625)).toBe(63);
    expect(percentOf(1)).toBe(100);
    expect(percentOf(1.2)).toBe(100);
    expect(percentOf(-0.3)).toBe(0);
    expect(percentOf(Number.NaN)).toBe(0);
  });

  it('帯は確率 25% で全幅。それ以上は全幅のまま。0 以下は空', () => {
    expect(barRatio(0)).toBe(0);
    expect(barRatio(-1)).toBe(0);
    expect(barRatio(0.125)).toBe(0.5);
    expect(barRatio(0.25)).toBe(1);
    expect(barRatio(0.9)).toBe(1);
    expect(barRatio(Number.NaN)).toBe(0);
  });

  it('数の色が濃くなるのは 10% から', () => {
    expect(STRONG_FROM).toBe(0.1);
  });

  it('数のボタンの名前と、他家の席の札の文', () => {
    expect(cellLabel('五筒', 0.1234)).toBe('五筒 の読み: だれかが待っている確率 12%');
    expect(cellLabel('東', 0.001)).toBe('東 の読み: だれかが待っている確率 0%');
    expect(chipText(0.62)).toBe('聴牌 62%');
    expect(chipText(1)).toBe('聴牌 100%');
  });

  it('他家の席の札: 席ごとの聴牌の確率', () => {
    const chips = tenpaiChips(moment(0, 2, { opponents: [opponent(1, 1, { tenpai: 0.62 }), opponent(2, 2, { tenpai: 0.05 }), opponent(3, 3, { tenpai: 1 })] }));
    expect([...chips]).toEqual([
      [1, 0.62],
      [2, 0.05],
      [3, 1],
    ]);
  });
});

describe('F23 卓の上の行（中央の箱が狭いとき）', () => {
  it('下家・対面・上家の順に、名前・リーチ・整数の % を返す（reads.json の順に頼らない）', () => {
    const items = tenpaiLineItems(moment(0, 2, { opponents: [opponent(3, 3, { tenpai: 1, riichi: true }), opponent(1, 1, { tenpai: 0.05 }), opponent(2, 2, { tenpai: 0.174 })] }));
    expect(items).toEqual([
      { seat: 1, name: '下家', riichi: false, percent: 5 },
      { seat: 2, name: '対面', riichi: false, percent: 17 },
      { seat: 3, name: '上家', riichi: true, percent: 100 },
    ]);
  });
});

describe('F23 読み直した他家', () => {
  it('リーチした他家か、聴牌の確率が 50% 以上の他家（ちょうど 50% を含む）', () => {
    expect(wasReread({ riichi: true, tenpai: 0.01 })).toBe(true);
    expect(wasReread({ riichi: false, tenpai: 0.5 })).toBe(true);
    expect(wasReread({ riichi: false, tenpai: 0.4999 })).toBe(false);
  });
});

describe('F23 吹き出しの中身（本物の牌譜 FX-4 の、上家がリーチ中の場面）', () => {
  const game = gameOf('fx4');
  const decision = game.decisions.find((d) => d.eventIndex === 88)!;
  const real = fx4Reads().moments.find((item) => item.event_index === 88)!;
  const view = { moment: real, board: decision.board };

  it('他家は下家・対面・上家の順。リーチは名前に付ける。リーチした上家にだけ守備の目安がある', () => {
    const explain = explainTile(view, '5s');
    expect(explain.opponents.map((o) => [o.name, o.riichi, o.defense === null])).toEqual([
      ['下家', false, true],
      ['対面', false, true],
      ['上家', true, false],
    ]);
    expect(explain.anyWait).toBe(percentOf(real.any_wait[tileKind('5s')] as number));
    for (const o of explain.opponents) {
      const source = real.opponents.find((candidate) => candidate.step === o.step)!;
      expect(o.tenpai).toBe(percentOf(source.tenpai));
      expect(o.wait).toBe(percentOf(source.waits[tileKind('5s')] as number));
    }
  });

  it('効いた捨て牌は 2 つまで、牌の呼び名は 5p の形。読みの上位は 5 牌。実際の待ちは牌の呼び名（字牌は漢字）', () => {
    const lines = explainTile(view, '5s').opponents[2]!.reread!;
    expect(lines.reasons).toEqual(['5 巡目の 3s（無ければ 16%）', '3 巡目の 9p（無ければ 11%）']);
    expect(lines.topWaits).toBe('5m 15% · 5s 13% · 9s 12% · 7m 12% · 6s 11%');
    expect(lines.actualWaits).toBe('發');
  });

  it('効いた捨て牌が無い牌は、空（画面は「大きく動かす捨て牌なし」を出す）。赤五は普通の五として探す', () => {
    expect(explainTile(view, '8m').opponents[2]!.reread!.reasons).toEqual([]);
    const reasons = (tile: string) => explainTile(view, tile).opponents[2]!.reread!.reasons;
    expect(reasons('5mr')).toEqual(reasons('5m'));
    expect(reasons('5m').length).toBeGreaterThan(0);
  });

  it('守備の目安は、リーチした他家だけ。現物・字牌・壁・スジ・無スジのどれか', () => {
    const board = decision.board;
    expect(riichiOpponentSeats(board)).toEqual([3]);
    for (const tile of [...board.hand, ...(board.drawn === null ? [] : [board.drawn])]) {
      const cells = defenseAgainst(board, tileKind(tile));
      expect([...cells.keys()]).toEqual([3]);
      expect(['現物', '字牌', '壁', 'スジ', '無スジ']).toContain(cells.get(3)!.cls);
    }
    // 上家の河にある牌は現物
    const river = board.rivers[3]!;
    expect(river.length).toBeGreaterThan(0);
    expect(defenseAgainst(board, tileKind(river[0]!.tile)).get(3)!.cls).toBe('現物');
  });

  it('リーチしていない他家は、守備の目安も（リーチの）名前の印も無い。聴牌の確率が 50% 未満の他家は、読み直した行も無い', () => {
    const calm = moment(0, 88, {
      opponents: [opponent(1, 1, { tenpai: 0.49 }), opponent(2, 2, { tenpai: 0.5, actual_waits: ['1m', 'C'], top_waits: [{ tile: '1m', p: 0.3 }] }), opponent(3, 3)],
    });
    const explain = explainTile({ moment: calm, board: decision.board }, '5s');
    expect(explain.opponents.map((o) => [o.riichi, o.defense, o.reread === null])).toEqual([
      [false, null, true],
      [false, null, false],
      [false, null, true],
    ]);
    expect(explain.opponents[1]!.reread).toEqual({ reasons: [], topWaits: '1m 30%', actualWaits: '1m・中' });
  });

  it('実際の待ちが空なら null（画面は「聴牌していなかった」を出す）', () => {
    const none = moment(0, 88, { opponents: [opponent(1, 1), opponent(2, 2), opponent(3, 3, { riichi: true, actual_waits: [] })] });
    expect(explainTile({ moment: none, board: decision.board }, '5s').opponents[2]!.reread!.actualWaits).toBeNull();
  });

  it('確率の表が短くても落ちない（足りない牌は 0）', () => {
    const short = moment(0, 88, { any_wait: [], opponents: [opponent(1, 1, { waits: [] }), opponent(2, 2), opponent(3, 3)] });
    const explain = explainTile({ moment: short, board: decision.board }, '5s');
    expect(explain.anyWait).toBe(0);
    expect(explain.opponents[0]!.wait).toBe(0);
    expect(EMPTY_WAITS()).toHaveLength(34);
  });
});
