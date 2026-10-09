import { describe, expect, it } from 'vitest';

import { kyokuLabel, kyokuNumber, seatWindsFor } from '../src/kyoku';
import { KyokuReplayer, ReplayLogError, replayFrames, splitKyokus } from '../src/replay';
import type { MjaiEvent, Seat, StartKyokuEvent } from '../src/report-types';

/** 手で作った1局。席0が親。牌の枚数が現実と合わない所があってもよい（再生は手牌にあるかだけを見る）。 */
function startKyoku(tehais: string[][], overrides: Partial<StartKyokuEvent> = {}): StartKyokuEvent {
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
    ...overrides,
  };
}

const HANDS = [
  ['1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '1s', '2s', '3s', 'E', 'E'],
  ['N', 'N', 'N', '1p', '1p', '1p', '4p', '5p', '6p', '7s', '8s', '9s', 'C'],
  ['1p', '2s', '3s', '4s', '7m', '8m', '9m', 'W', 'W', 'W', '5s', '6s', '7s'],
  ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '8p'],
];

function run(events: MjaiEvent[], playerId: Seat = 1, tehais: string[][] = HANDS): KyokuReplayer {
  const replayer = new KyokuReplayer(startKyoku(tehais), playerId);
  events.forEach((e, i) => replayer.apply(e, i + 1));
  return replayer;
}

describe('E-2 再生: 鳴きと巡目・残り枚数', () => {
  it('E-2 ポンで巡目が増え、鳴かれた牌には鳴いた席が付き、副露と手牌が更新される', () => {
    const r = run([
      { type: 'tsumo', actor: 0, pai: 'N' },
      { type: 'dahai', actor: 0, pai: 'N', tsumogiri: true },
      { type: 'pon', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N'] },
    ]);
    const b = r.snapshot();
    expect(b.junme).toBe(1);
    expect(b.tilesLeft).toBe(69);
    expect(b.melds[1]).toEqual([{ type: 'pon', target: 0, pai: 'N', consumed: ['N', 'N'] }]);
    expect(b.handCounts[1]).toBe(11);
    expect(b.hand).toHaveLength(11);
    expect(b.drawn).toBeNull();
    expect(b.rivers[0]).toEqual([{ tile: 'N', tsumogiri: true, riichi: false, calledBy: 1 }]);
    expect(r.lastActor).toBe(1);
    expect(r.lastTile).toBe('N');
  });

  it('E-2 大明槓では巡目が増えない。そのあとの嶺上のツモで増え、残り枚数も1つ減る', () => {
    const r = run([
      { type: 'tsumo', actor: 0, pai: 'N' },
      { type: 'dahai', actor: 0, pai: 'N', tsumogiri: true },
      { type: 'pon', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N'] },
      { type: 'dahai', actor: 1, pai: 'C', tsumogiri: false },
      { type: 'tsumo', actor: 2, pai: '1p' },
      { type: 'dahai', actor: 2, pai: '1p', tsumogiri: true },
    ]);
    expect(r.junme).toBe(1);
    expect(r.tilesLeft).toBe(68);
    r.apply({ type: 'daiminkan', actor: 1, target: 2, pai: '1p', consumed: ['1p', '1p', '1p'] }, 7);
    const afterKan = r.snapshot();
    expect(afterKan.junme).toBe(1);
    expect(afterKan.tilesLeft).toBe(68);
    expect(afterKan.melds[1]).toHaveLength(2);
    expect(afterKan.melds[1]?.[1]).toEqual({ type: 'daiminkan', target: 2, pai: '1p', consumed: ['1p', '1p', '1p'] });
    expect(afterKan.rivers[2]?.[0]?.calledBy).toBe(1);
    r.apply({ type: 'tsumo', actor: 1, pai: 'W' }, 8);
    const afterRinshan = r.snapshot();
    expect(afterRinshan.junme).toBe(2);
    expect(afterRinshan.tilesLeft).toBe(67);
    expect(afterRinshan.drawn).toBe('W');
  });

  it('E-2 暗槓: 4枚が手牌（ツモ牌を含む）から出て、副露になり、ツモ牌は無くなる', () => {
    const r = run([
      { type: 'tsumo', actor: 1, pai: 'N' },
      { type: 'ankan', actor: 1, consumed: ['N', 'N', 'N', 'N'] },
    ]);
    const b = r.snapshot();
    expect(b.melds[1]).toEqual([{ type: 'ankan', consumed: ['N', 'N', 'N', 'N'] }]);
    expect(b.drawn).toBeNull();
    expect(b.hand).not.toContain('N');
    expect(b.handCounts[1]).toBe(10);
    expect(b.junme).toBe(1);
    r.apply({ type: 'tsumo', actor: 1, pai: '2m' }, 3);
    r.apply({ type: 'dora', dora_marker: '9s' }, 4);
    const after = r.snapshot();
    expect(after.junme).toBe(2);
    expect(after.drawn).toBe('2m');
    expect(after.doraMarkers).toEqual(['4p', '9s']);
  });

  it('E-2 加槓: ポンが加槓に変わり（previous_pon_*）、加える牌が手牌から出る。tile は加槓の牌になる', () => {
    const hands = [HANDS[0] as string[], ['E', 'E', ...(HANDS[1] as string[]).slice(2)], HANDS[2] as string[], HANDS[3] as string[]];
    const r = run(
      [
        { type: 'tsumo', actor: 0, pai: 'E' },
        { type: 'dahai', actor: 0, pai: 'E', tsumogiri: true },
        { type: 'pon', actor: 1, target: 0, pai: 'E', consumed: ['E', 'E'] },
        { type: 'dahai', actor: 1, pai: 'C', tsumogiri: false },
        { type: 'tsumo', actor: 1, pai: 'E' },
        { type: 'kakan', actor: 1, pai: 'E', consumed: ['E', 'E', 'E'] },
      ],
      1,
      hands,
    );
    const b = r.snapshot();
    expect(b.melds[1]).toEqual([
      { type: 'kakan', pai: 'E', previous_pon_target: 0, previous_pon_pai: 'E', consumed: ['E', 'E'] },
    ]);
    expect(b.drawn).toBeNull();
    expect(b.hand).not.toContain('E');
    expect(r.lastTile).toBe('E');
    expect(r.lastActor).toBe(1);
  });

  it('E-2 チー: 鳴かれた牌に鳴いた席が付き、巡目が増える', () => {
    // 席2（本人）が席1の 3s をチーする（席2の手牌は 2s・4s を持っている）
    const tehais = [
      HANDS[0] as string[],
      ['1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '3s', '9s', '9s', 'E', 'E'],
      ['2s', '4s', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', 'C', 'C'],
      HANDS[3] as string[],
    ];
    const r = run(
      [
        { type: 'tsumo', actor: 1, pai: '5s' },
        { type: 'dahai', actor: 1, pai: '3s', tsumogiri: false },
        { type: 'chi', actor: 2, target: 1, pai: '3s', consumed: ['2s', '4s'] },
      ],
      2,
      tehais,
    );
    const b = r.snapshot();
    expect(b.junme).toBe(1);
    expect(b.melds[2]).toEqual([{ type: 'chi', target: 1, pai: '3s', consumed: ['2s', '4s'] }]);
    expect(b.rivers[1]?.[0]?.calledBy).toBe(2);
    expect(b.handCounts[2]).toBe(11);
  });
});

describe('E-2 再生: リーチ・点数・ドラ・風', () => {
  it('E-2 リーチの宣言牌に印が付き、成立で点数が1000減り供託が増える。宣言から成立までは declared', () => {
    const r = run([{ type: 'tsumo', actor: 0, pai: 'E' }, { type: 'reach', actor: 0 }], 1);
    expect(r.snapshot().riichi[0]).toBe('declared');
    expect(r.snapshot().scores[0]).toBe(25000);
    r.apply({ type: 'dahai', actor: 0, pai: 'E', tsumogiri: true }, 3);
    let b = r.snapshot();
    expect(b.rivers[0]?.[0]).toEqual({ tile: 'E', tsumogiri: true, riichi: true, calledBy: null });
    expect(b.riichi[0]).toBe('declared');
    r.apply({ type: 'reach_accepted', actor: 0 }, 4);
    b = r.snapshot();
    expect(b.riichi[0]).toBe('accepted');
    expect(b.scores).toEqual([24000, 25000, 25000, 25000]);
    expect(b.kyotaku).toBe(1);
    // 次の打牌には印が付かない
    r.apply({ type: 'tsumo', actor: 0, pai: '1s' }, 5);
    r.apply({ type: 'dahai', actor: 0, pai: '1s', tsumogiri: true }, 6);
    expect(r.snapshot().rivers[0]?.[1]?.riichi).toBe(false);
  });

  it('E-2 供託・本場・ドラ表示牌・親と自風・場風が、start_kyoku の値から入る', () => {
    const replayer = new KyokuReplayer(
      startKyoku(HANDS, { bakaze: 'S', kyoku: 3, honba: 2, kyotaku: 1, oya: 2, dora_marker: 'C', scores: [10000, 20000, 30000, 40000] }),
      0,
    );
    const b = replayer.snapshot();
    expect(b.roundWind).toBe('S');
    expect(b.kyoku).toBe(3);
    expect(b.kyokuIndex).toBe(6);
    expect(b.honba).toBe(2);
    expect(b.kyotaku).toBe(1);
    expect(b.oya).toBe(2);
    expect(b.seatWinds).toEqual(['W', 'N', 'E', 'S']);
    expect(b.doraMarkers).toEqual(['C']);
    expect(b.scores).toEqual([10000, 20000, 30000, 40000]);
    expect(b.tilesLeft).toBe(70);
    expect(b.junme).toBe(0);
  });

  it('E-2 盤面は、そのあとの event を進めても変わらない（コピー）', () => {
    const r = run([{ type: 'tsumo', actor: 0, pai: 'N' }]);
    const before = r.snapshot();
    const riverBefore = JSON.stringify(before.rivers);
    r.apply({ type: 'dahai', actor: 0, pai: 'N', tsumogiri: true }, 2);
    r.apply({ type: 'pon', actor: 1, target: 0, pai: 'N', consumed: ['N', 'N'] }, 3);
    expect(JSON.stringify(before.rivers)).toBe(riverBefore);
    expect(before.melds[1]).toEqual([]);
    expect(before.tilesLeft).toBe(69);
  });
});

describe('E-2 再生: 牌譜が矛盾しているとき', () => {
  it('E-2 手牌に無い牌を切ると、牌譜の中の位置つきの ReplayLogError', () => {
    const r = new KyokuReplayer(startKyoku(HANDS), 1);
    expect(() => r.apply({ type: 'dahai', actor: 2, pai: 'C', tsumogiri: false }, 5)).toThrow(ReplayLogError);
    try {
      r.apply({ type: 'dahai', actor: 2, pai: 'C', tsumogiri: false }, 5);
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayLogError);
      expect((e as ReplayLogError).eventIndex).toBe(5);
      expect((e as ReplayLogError).message).toContain('席2');
      expect((e as ReplayLogError).message).toContain('C');
    }
  });

  it('E-2 最後の捨て牌でない牌を鳴く・ポンの無い加槓は ReplayLogError', () => {
    const r = new KyokuReplayer(startKyoku(HANDS), 1);
    r.apply({ type: 'tsumo', actor: 0, pai: 'N' }, 1);
    r.apply({ type: 'dahai', actor: 0, pai: 'N', tsumogiri: true }, 2);
    expect(() => r.apply({ type: 'pon', actor: 1, target: 0, pai: 'E', consumed: ['N', 'N'] }, 3)).toThrow(ReplayLogError);
    const k = new KyokuReplayer(startKyoku(HANDS), 1);
    expect(() => k.apply({ type: 'kakan', actor: 1, pai: 'N', consumed: ['N', 'N', 'N'] }, 1)).toThrow(ReplayLogError);
  });
});

describe('E-2 局の区切りと event ごとの盤面', () => {
  const log: MjaiEvent[] = [
    { type: 'start_game', names: ['A', 'B', 'C', 'D'] },
    startKyoku(HANDS),
    { type: 'tsumo', actor: 0, pai: 'N' },
    { type: 'dahai', actor: 0, pai: 'N', tsumogiri: true },
    { type: 'ryukyoku', deltas: [0, 0, 0, 0] },
    { type: 'end_kyoku' },
    startKyoku(HANDS, { kyoku: 2, oya: 1 }),
    { type: 'tsumo', actor: 1, pai: 'W' },
    { type: 'end_kyoku' },
    { type: 'end_game' },
  ];

  it('E-2 start_kyoku で局に分け、start_game・end_game は含めない。位置は mjai_log の中の位置', () => {
    const kyokus = splitKyokus(log);
    expect(kyokus).toHaveLength(2);
    expect(kyokus[0]?.startIndex).toBe(1);
    expect(kyokus[0]?.events.map((e) => e.type)).toEqual(['start_kyoku', 'tsumo', 'dahai', 'ryukyoku', 'end_kyoku']);
    expect(kyokus[1]?.startIndex).toBe(6);
    expect(kyokus[1]?.events.map((e) => e.type)).toEqual(['start_kyoku', 'tsumo', 'end_kyoku']);
  });

  it('E-2 replayFrames は、局の最初（配牌）から event ごとの盤面を返す', () => {
    const kyoku = splitKyokus(log)[0];
    if (!kyoku) throw new Error('局がありません');
    const frames = replayFrames(kyoku, 1);
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.eventIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(frames.map((f) => f.board.tilesLeft)).toEqual([70, 69, 69, 69, 69]);
    expect(frames[2]?.board.rivers[0]).toHaveLength(1);
    expect(frames[1]?.board.rivers[0]).toHaveLength(0);
  });
});

describe('局の名前と風', () => {
  it('局の名前は、東1局・東4局・南1局・西1局と、本場がつく形', () => {
    expect(kyokuLabel(0, 0)).toBe('東1局');
    expect(kyokuLabel(3, 0)).toBe('東4局');
    expect(kyokuLabel(2, 1)).toBe('東3局1本場');
    expect(kyokuLabel(4, 0)).toBe('南1局');
    expect(kyokuLabel(8, 0)).toBe('西1局');
    expect(kyokuLabel(11, 3)).toBe('西4局3本場');
  });

  it('場風と場の中の局の番号から、局の通し番号になる', () => {
    expect(kyokuNumber('E', 1)).toBe(0);
    expect(kyokuNumber('E', 4)).toBe(3);
    expect(kyokuNumber('S', 1)).toBe(4);
    expect(kyokuNumber('S', 2)).toBe(5);
    expect(kyokuNumber('W', 1)).toBe(8);
  });

  it('自風は親が東で、席の順に南・西・北', () => {
    expect(seatWindsFor(0)).toEqual(['E', 'S', 'W', 'N']);
    expect(seatWindsFor(1)).toEqual(['N', 'E', 'S', 'W']);
    expect(seatWindsFor(2)).toEqual(['W', 'N', 'E', 'S']);
    expect(seatWindsFor(3)).toEqual(['S', 'W', 'N', 'E']);
  });
});
