import { describe, expect, it } from 'vitest';

import { importReport } from '../src/import';
import type { ActionEvent, ReportEntry, Seat } from '../src/report-types';
import { type LooseJson } from './helpers/fixtures';

// FX-1 に無い場面（他家の加槓への判断、自分の大明槓のあとの巡目）を、手で作った小さな結果 JSON で確かめる。

const none: ActionEvent = { type: 'none' };

function entry(overrides: Partial<ReportEntry> & Pick<ReportEntry, 'junme' | 'tiles_left' | 'last_actor' | 'tile'>): ReportEntry {
  return {
    state: { tehai: [], fuuros: [] },
    at_self_chi_pon: false,
    at_self_riichi: false,
    at_opponent_kakan: false,
    expected: none,
    actual: none,
    is_equal: true,
    details: [
      { action: none, q_value: 0.4, prob: 0.8 },
      { action: { type: 'hora', actor: 2, target: 1 }, q_value: -0.2, prob: 0.2 },
    ],
    shanten: 1,
    at_furiten: false,
    actual_index: 0,
    ...overrides,
  };
}

function report(playerId: Seat, events: object[], entries: ReportEntry[]): LooseJson {
  return {
    engine: 'Mortal',
    game_length: 'Hanchan',
    version: 'test',
    review: {
      total_reviewed: entries.length,
      total_matches: entries.length,
      rating: 1,
      temperature: 0.1,
      kyokus: [
        {
          kyoku: 0,
          honba: 0,
          end_status: [{ type: 'ryukyoku', deltas: [0, 0, 0, 0] }],
          relative_scores: [25000, 25000, 25000, 25000],
          entries,
        },
      ],
      relative_phi_matrix: [[[0.25, 0.25, 0.25, 0.25]]],
      model_tag: 'test',
    },
    player_id: playerId,
    split_logs: [],
    mjai_log: [
      { type: 'start_game', names: ['A', 'B', 'C', 'D'] },
      ...events,
      { type: 'ryukyoku', deltas: [0, 0, 0, 0] },
      { type: 'end_kyoku' },
      { type: 'end_game' },
    ],
  };
}

function start(tehais: string[][]): object {
  return {
    type: 'start_kyoku',
    bakaze: 'E',
    dora_marker: '4p',
    kyoku: 1,
    honba: 0,
    kyotaku: 0,
    oya: 0,
    scores: [25000, 25000, 25000, 25000],
    tehais,
  };
}

describe('E-2 手で作った結果 JSON: 他家の加槓への判断（at_opponent_kakan）', () => {
  const tehais = [
    ['1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '1s', '2s', '3s', 'E', 'E'],
    ['N', 'N', '1p', '2p', '3p', '4s', '5s', '6s', '7s', '8s', '9s', 'C', 'C'],
    ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '1p', '2s', '2s'],
    ['9p', '9p', '8p', '8p', '7p', '7p', '6p', '6p', '5p', '5p', '4p', '4p', '3p'],
  ];
  const events = [
    start(tehais),
    { type: 'tsumo', actor: 0, pai: 'N' },
    { type: 'dahai', actor: 0, pai: 'N', tsumogiri: true },
    { type: 'pon', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N'] },
    { type: 'dahai', actor: 1, pai: 'C', tsumogiri: false },
    { type: 'tsumo', actor: 2, pai: '3p' },
    { type: 'dahai', actor: 2, pai: '3p', tsumogiri: true },
    { type: 'tsumo', actor: 3, pai: 'E' },
    { type: 'dahai', actor: 3, pai: 'E', tsumogiri: true },
    { type: 'tsumo', actor: 0, pai: '9s' },
    { type: 'dahai', actor: 0, pai: '9s', tsumogiri: true },
    { type: 'tsumo', actor: 1, pai: 'N' },
    { type: 'kakan', actor: 1, pai: 'N', consumed: ['N', 'N', 'N'] },
    { type: 'tsumo', actor: 1, pai: '2m' },
    { type: 'dahai', actor: 1, pai: '2m', tsumogiri: true },
  ];
  const own = tehais[2] as string[];
  const atDraw = entry({
    junme: 1,
    tiles_left: 68,
    last_actor: 2,
    tile: '3p',
    state: { tehai: [...own, '3p'], fuuros: [] },
    expected: { type: 'dahai', actor: 2, pai: '3p', tsumogiri: true },
    actual: { type: 'dahai', actor: 2, pai: '3p', tsumogiri: true },
    details: [
      { action: { type: 'dahai', actor: 2, pai: '3p', tsumogiri: true }, q_value: 0.5, prob: 0.6 },
      { action: { type: 'dahai', actor: 2, pai: '9m', tsumogiri: false }, q_value: 0.1, prob: 0.4 },
    ],
  });
  const atKakan = entry({
    junme: 1,
    tiles_left: 65,
    last_actor: 1,
    tile: 'N',
    at_opponent_kakan: true,
    state: { tehai: own, fuuros: [] },
  });

  it('E-2 他家の加槓の直後に、本人の判断（at_opponent_kakan）を当てはめ、盤面に加槓と鳴かれた牌が入る', () => {
    const result = importReport(report(2, events, [atDraw, atKakan]));
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions).toHaveLength(2);
    const d = result.value.decisions[1];
    expect(d?.entry.at_opponent_kakan).toBe(true);
    expect(d?.kind).toBe('win');
    expect(d?.board.melds[1]).toEqual([
      { type: 'kakan', pai: 'N', previous_pon_target: 0, previous_pon_pai: 'N', consumed: ['N', 'N'] },
    ]);
    expect(d?.board.rivers[0]?.[0]?.calledBy).toBe(1);
    expect(d?.board.junme).toBe(1);
    expect(d?.board.tilesLeft).toBe(65);
    expect(d?.board.drawn).toBeNull();
  });

  it('E-2 at_opponent_kakan が牌譜と合わない（加槓の判断なのにフラグが無い）判断は、対応する局面が見つからず失敗する', () => {
    const wrong = entry({ ...atKakan, at_opponent_kakan: false });
    const result = importReport(report(2, events, [atDraw, wrong]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('no-position');
  });
});

describe('E-2 手で作った結果 JSON: 自分の大明槓のあとの巡目と手牌', () => {
  const tehais = [
    ['1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '1s', '2s', '3s', 'E', 'E'],
    ['N', 'N', 'N', '1p', '2p', '3p', '4s', '5s', '6s', '7s', '8s', '9s', 'C'],
    ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '1p', '2s', '2s'],
    ['9p', '9p', '8p', '8p', '7p', '7p', '6p', '6p', '5p', '5p', '4p', '4p', '3p'],
  ];
  const events = [
    start(tehais),
    { type: 'tsumo', actor: 0, pai: 'N' },
    { type: 'dahai', actor: 0, pai: 'N', tsumogiri: true },
    { type: 'daiminkan', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N', 'N'] },
    { type: 'tsumo', actor: 1, pai: 'C' },
    { type: 'dora', dora_marker: '9s' },
    { type: 'dahai', actor: 1, pai: 'C', tsumogiri: true },
  ];
  const daiminkanAction: ActionEvent = { type: 'daiminkan', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N', 'N'] };
  const reaction = entry({
    junme: 0,
    tiles_left: 69,
    last_actor: 0,
    tile: 'N',
    state: { tehai: tehais[1] as string[], fuuros: [] },
    expected: daiminkanAction,
    actual: daiminkanAction,
    details: [
      { action: { type: 'ankan', actor: 1, consumed: ['N', 'N', 'N', 'N'] }, q_value: 0.5, prob: 0.5 },
      { action: { type: 'pon', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N'] }, q_value: 0.4, prob: 0.3 },
      { action: none, q_value: 0.2, prob: 0.2 },
    ],
    actual_index: 0,
  });
  const afterRinshan = entry({
    junme: 1,
    tiles_left: 68,
    last_actor: 1,
    tile: 'C',
    state: {
      tehai: ['1p', '2p', '3p', '4s', '5s', '6s', '7s', '8s', '9s', 'C', 'C'],
      fuuros: [{ type: 'daiminkan', target: 0, pai: 'N', consumed: ['N', 'N', 'N'] }],
    },
    expected: { type: 'dahai', actor: 1, pai: 'C', tsumogiri: true },
    actual: { type: 'dahai', actor: 1, pai: 'C', tsumogiri: true },
    details: [
      { action: { type: 'dahai', actor: 1, pai: 'C', tsumogiri: true }, q_value: 0.3, prob: 0.7 },
      { action: { type: 'dahai', actor: 1, pai: '1p', tsumogiri: false }, q_value: 0.0, prob: 0.3 },
    ],
  });

  it('E-2 大明槓の判断は鳴きとして扱われ、そのあとの嶺上のツモの判断は巡目 1・手牌は副露を除いた11枚（ツモ牌含む）', () => {
    const result = importReport(report(1, events, [reaction, afterRinshan]));
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    const [call, draw] = result.value.decisions;
    expect(call?.kind).toBe('call');
    expect(call?.board.junme).toBe(0);
    expect(draw?.board.junme).toBe(1);
    expect(draw?.board.drawn).toBe('C');
    expect(draw?.board.hand).toHaveLength(10);
    expect(draw?.board.doraMarkers).toEqual(['4p']);
    expect(draw?.board.melds[1]).toEqual([{ type: 'daiminkan', target: 0, pai: 'N', consumed: ['N', 'N', 'N'] }]);
    expect(draw?.kind).toBe('discard');
  });
});
