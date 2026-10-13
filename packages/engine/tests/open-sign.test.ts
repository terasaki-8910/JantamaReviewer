import { describe, expect, it } from 'vitest';

import { dangerBoxOf } from '../src/danger';
import type { Decision } from '../src/decision';
import { importReportText } from '../src/import';
import { type OpenSign, isOpenTarget, openSignLinesOf, openSignOf, openSignText } from '../src/open-sign';
import { actualChoice } from '../src/quiz-choice';
import type { BoardState } from '../src/replay';
import type { Fuuro, ReportEntry, Seat } from '../src/report-types';
import { type Tile, parseTenhouNotation } from '../src/tiles';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// F14・E-39（R16-6 の B）: 副露の気配の 1 行（open-sign.ts）。リーチしていない他家のうち、副露が 2 つ以上の人か、染め手の気配の人に、
// 「下家: 2副露・索子の染め手の気配・役牌の刻子（發）」のような 1 行を出す。牌ごとの分類は出さない。暗槓は副露の数に入らず、リーチの人は対象にならない。
// 1. 手で作った盤面: 対象の決まり・行の文・役牌（場風・自風・三元牌）・並び順
// 2. 守備のタブの中身 `dangerBoxOf`: リーチの人がいなくても、対象の人がいれば出る。リーチの人の欄の次に並ぶ
// 3. 固定データの 7 半荘: 対象になる場面が実在し、どの場面でも、リーチの人は対象に入らない

/** 手で作った盤面（東場・自分は席 0 の親。自風は 席 1 = 南、席 2 = 西、席 3 = 北）。 */
function boardOf(over: Partial<BoardState> = {}): BoardState {
  return {
    playerId: 0,
    kyokuIndex: 0,
    roundWind: 'E',
    kyoku: 1,
    honba: 0,
    kyotaku: 0,
    oya: 0,
    seatWinds: ['E', 'S', 'W', 'N'],
    scores: [25000, 25000, 25000, 25000],
    doraMarkers: [],
    tilesLeft: 50,
    junme: 8,
    hand: [],
    drawn: null,
    handCounts: [14, 13, 13, 13],
    handDrawn: [false, false, false, false],
    rivers: [[], [], [], []],
    melds: [[], [], [], []],
    riichi: ['none', 'none', 'none', 'none'],
    riichiOrder: [],
    passedAfterRiichi: [[], [], [], []],
    ...over,
  };
}

const river = (tiles: string) => parseTenhouNotation(tiles).map((tile) => ({ tile, tsumogiri: false, riichi: false, calledBy: null }));
const chi = (pai: Tile, consumed: [Tile, Tile], target: Seat = 0): Fuuro => ({ type: 'chi', target, pai, consumed });
const pon = (pai: Tile, target: Seat = 0): Fuuro => ({ type: 'pon', target, pai, consumed: [pai, pai] });
const ankan = (pai: Tile): Fuuro => ({ type: 'ankan', consumed: [pai, pai, pai, pai] });
const melds = (seat: Seat, list: Fuuro[]): BoardState['melds'] => [0, 1, 2, 3].map((s) => (s === seat ? list : [])) as unknown as BoardState['melds'];
const riversOf = (seat: Seat, tiles: string): BoardState['rivers'] => [0, 1, 2, 3].map((s) => (s === seat ? river(tiles) : [])) as unknown as BoardState['rivers'];

const lines = (board: BoardState) => openSignLinesOf(board).map((line) => line.text);

describe('E-39 副露の気配: 対象の決まり', () => {
  it('副露が 1 つだけで、染め手の気配も無い人は、対象にならない（字牌だけの副露は、色が決まらない）', () => {
    expect(lines(boardOf({ melds: melds(1, [pon('F')]) }))).toEqual([]);
    // 数牌のチー 1 つだけでも、色が決まる（染め手の気配）ので、河の色が 1 枚以下なら対象
    expect(lines(boardOf({ melds: melds(1, [chi('3s', ['4s', '5s'])]) }))).toEqual(['下家: 1副露・索子の染め手の気配']);
  });

  it('副露が 2 つ以上なら対象（色がばらばらでもよい）。行は副露の数だけ', () => {
    const board = boardOf({ melds: melds(2, [chi('1m', ['2m', '3m']), pon('5p')]) });
    expect(lines(board)).toEqual(['対面: 2副露']);
    expect(openSignOf(board, 2)).toMatchObject({ openMelds: 2, suit: null, suitSign: false, yakuhai: [] });
  });

  it('染め手の気配: 副露がすべて同じ 1 色の数牌と字牌だけで、河にその色が 1 枚以下。河に 2 枚あれば、気配が消える', () => {
    const base = melds(3, [chi('3s', ['4s', '5s']), pon('7s')]);
    expect(lines(boardOf({ melds: base, rivers: riversOf(3, '1m9p1z2s') }))).toEqual(['上家: 2副露・索子の染め手の気配']);
    // 色が 1 枚以下の境目（1 枚は気配あり、2 枚で消える）。2 副露なので、気配が消えても、副露の数で対象のまま（行から染め手が消える）
    expect(lines(boardOf({ melds: base, rivers: riversOf(3, '1m9p1z2s6s') }))).toEqual(['上家: 2副露']);
    // 副露が 1 つのとき、河に色が 2 枚あれば、対象から外れる
    expect(lines(boardOf({ melds: melds(3, [chi('3s', ['4s', '5s'])]), rivers: riversOf(3, '2s6s') }))).toEqual([]);
    expect(openSignOf(boardOf({ melds: melds(3, [chi('3s', ['4s', '5s'])]), rivers: riversOf(3, '2s6s') }), 3)).toMatchObject({ suit: 2, suitSign: false });
  });

  it('染め手の気配の色は、萬子・筒子・索子。副露に、別の色の数牌が混ざれば、染め手ではない', () => {
    expect(lines(boardOf({ melds: melds(1, [chi('3m', ['4m', '5m'])]) }))).toEqual(['下家: 1副露・萬子の染め手の気配']);
    expect(lines(boardOf({ melds: melds(1, [pon('5p')]) }))).toEqual(['下家: 1副露・筒子の染め手の気配']);
    expect(lines(boardOf({ melds: melds(1, [chi('3m', ['4m', '5m']), pon('5p')]) }))).toEqual(['下家: 2副露']);
  });

  it('染め手の気配は、字牌の副露を混ぜてもよい（色の副露が 1 つ以上ある）。字牌だけの副露が 2 つなら、副露の数で対象だが、染め手ではない', () => {
    expect(lines(boardOf({ melds: melds(1, [chi('3m', ['4m', '5m']), pon('F')]) }))).toEqual(['下家: 2副露・萬子の染め手の気配・役牌の刻子（發）']);
    const honors = boardOf({ melds: melds(1, [pon('P'), pon('F')]) });
    expect(lines(honors)).toEqual(['下家: 2副露・役牌の刻子（白・發）']);
    expect(openSignOf(honors, 1)).toMatchObject({ suit: null, suitSign: false });
  });

  it('暗槓は副露の数に入らない。暗槓だけの人は対象にならない。暗槓を含めて色が決まる（染め手の判定には使う）', () => {
    // 暗槓 2 つ（副露 0）は対象外
    expect(lines(boardOf({ melds: melds(1, [ankan('5m'), ankan('9p')]) }))).toEqual([]);
    // 暗槓 + ポン: 副露は 1 つ（暗槓は数えない）。色がばらばらなので、染め手でもない
    const mixed = boardOf({ melds: melds(1, [ankan('5m'), pon('9p')]) });
    expect(lines(mixed)).toEqual([]);
    expect(openSignOf(mixed, 1).openMelds).toBe(1);
    // 暗槓 + ポン（同じ色）: 副露は 1 つで、色が同じなので、染め手の気配。行の副露は 1 つ
    expect(lines(boardOf({ melds: melds(1, [ankan('5p'), pon('9p')]) }))).toEqual(['下家: 1副露・筒子の染め手の気配']);
    // ポン 2 つ + 暗槓: 副露は 2 つ（暗槓は数えない）
    expect(lines(boardOf({ melds: melds(1, [pon('1m'), pon('5p'), ankan('9s')]) }))).toEqual(['下家: 2副露']);
    // 副露 1 つ + 暗槓の色が違う: 色が 2 色なので、染め手ではない
    expect(lines(boardOf({ melds: melds(1, [chi('1m', ['2m', '3m']), ankan('5p')]) }))).toEqual([]);
  });

  it('大明槓・加槓は副露の数に入る', () => {
    const daiminkan: Fuuro = { type: 'daiminkan', target: 0, pai: '5p', consumed: ['5p', '5p', '5p'] };
    const kakan: Fuuro = { type: 'kakan', pai: '9m', previous_pon_target: 0, previous_pon_pai: '9m', consumed: ['9m', '9m'] };
    expect(lines(boardOf({ melds: melds(2, [daiminkan, kakan]) }))).toEqual(['対面: 2副露']);
  });

  it('リーチした人は、副露が何個あっても対象にならない（宣言したが宣言牌がまだ通っていない人も）。本人も対象にならない', () => {
    const three = [pon('1m'), pon('5p'), pon('9s')];
    expect(lines(boardOf({ melds: melds(1, three), riichi: ['none', 'accepted', 'none', 'none'], riichiOrder: [1] }))).toEqual([]);
    expect(lines(boardOf({ melds: melds(1, three), riichi: ['none', 'declared', 'none', 'none'], riichiOrder: [1] }))).toEqual([]);
    expect(lines(boardOf({ melds: melds(0, three) }))).toEqual([]);
  });

  it('リーチの人と対象の人が並ぶとき、行に出るのは対象の人だけ。並びは下家・対面・上家の順', () => {
    const board = boardOf({
      melds: [[], [pon('1m'), pon('5p')], [pon('2m'), pon('6p')], [pon('3m'), pon('7p')]] as unknown as BoardState['melds'],
      riichi: ['none', 'none', 'accepted', 'none'],
      riichiOrder: [2],
    });
    expect(openSignLinesOf(board).map((line) => `${line.seat}:${line.who}`)).toEqual(['1:下家', '3:上家']);
    // 自分が席 2 のとき: 下家は席 3、対面は席 0、上家は席 1
    const me2 = boardOf({
      playerId: 2,
      melds: [[pon('1m'), pon('5p')], [pon('2m'), pon('6p')], [], [pon('3m'), pon('7p')]] as unknown as BoardState['melds'],
    });
    expect(openSignLinesOf(me2).map((line) => `${line.seat}:${line.who}`)).toEqual(['3:下家', '0:対面', '1:上家']);
  });
});

describe('E-39 副露の気配: 役牌の刻子（場風・自風・白發中のポン・カン）', () => {
  const text = (seat: Seat, list: Fuuro[], over: Partial<BoardState> = {}) => lines(boardOf({ melds: melds(seat, list), ...over }));

  it('場風（東場の東）・自風・三元牌が出る。自風でない風牌・場風でない風牌は出ない', () => {
    // 席 1 は南家。東（場風）・南（自風）・發は役牌。西・北は役牌ではない
    expect(text(1, [pon('E'), pon('S')])).toEqual(['下家: 2副露・役牌の刻子（東・南）']);
    expect(text(1, [pon('W'), pon('N')])).toEqual(['下家: 2副露']);
    // 席 2 は西家
    expect(text(2, [pon('W'), pon('C')])).toEqual(['対面: 2副露・役牌の刻子（西・中）']);
    // 南場では、南が場風になる（席 1 は東家でも、南場の南は役牌）
    expect(text(2, [pon('S'), pon('N')], { roundWind: 'S' })).toEqual(['対面: 2副露・役牌の刻子（南）']);
  });

  it('大明槓・加槓・暗槓の役牌も出る。種類は小さい順（東南西北白發中）', () => {
    const kanOfC: Fuuro = { type: 'daiminkan', target: 0, pai: 'C', consumed: ['C', 'C', 'C'] };
    const kakanOfP: Fuuro = { type: 'kakan', pai: 'P', previous_pon_target: 0, previous_pon_pai: 'P', consumed: ['P', 'P'] };
    expect(text(1, [kanOfC, kakanOfP])).toEqual(['下家: 2副露・役牌の刻子（白・中）']);
    // 暗槓の役牌は、役牌の刻子には出るが、副露の数には入らない（ほかに副露が 1 つあれば対象）
    expect(text(1, [ankan('F'), chi('1m', ['2m', '3m'])])).toEqual(['下家: 1副露・萬子の染め手の気配・役牌の刻子（發）']);
  });

  it('openSignText: 副露の数・染め手・役牌の順', () => {
    const sign: OpenSign = { seat: 3, openMelds: 2, suit: 2, suitSign: true, yakuhai: [31, 32] };
    expect(openSignText(sign)).toBe('2副露・索子の染め手の気配・役牌の刻子（白・發）');
    expect(isOpenTarget(sign)).toBe(true);
    expect(isOpenTarget({ seat: 1, openMelds: 1, suit: null, suitSign: false, yakuhai: [] })).toBe(false);
  });
});

// ---- 守備のタブの中身（dangerBoxOf）に、1 行が入る ----

function entryOf(): ReportEntry {
  const action = (pai: Tile) => ({ type: 'dahai' as const, actor: 0 as Seat, pai, tsumogiri: false });
  return {
    junme: 8,
    tiles_left: 50,
    last_actor: 0,
    tile: '3m',
    state: { tehai: [], fuuros: [] },
    at_self_chi_pon: false,
    at_self_riichi: false,
    at_opponent_kakan: false,
    expected: action('3m'),
    actual: action('3m'),
    is_equal: true,
    details: [{ action: action('3m'), q_value: 1, prob: 0.9 }],
    shanten: 1,
    at_furiten: false,
    actual_index: 0,
  };
}

function decisionOf(over: Partial<BoardState>, kind: Decision['kind'] = 'discard'): Pick<Decision, 'kind' | 'entry' | 'board'> {
  return { kind, entry: entryOf(), board: boardOf({ hand: parseTenhouNotation('112m456p789s1155z'), drawn: '3m', ...over }) };
}

const mine = { type: 'dahai' as const, tile: '3m' as Tile };

describe('E-39 dangerBoxOf: 副露の気配の 1 行（タブ「守備」の出る場面）', () => {
  const opens = melds(3, [chi('3s', ['4s', '5s']), pon('F')]);

  it('リーチの人がいなくても、対象の人がいれば出る。行だけ（欄は無い）', () => {
    const box = dangerBoxOf(decisionOf({ melds: opens }), mine);
    expect(box).not.toBeNull();
    expect(box?.sections).toEqual([]);
    expect(box?.signs.map((line) => line.text)).toEqual(['上家: 2副露・索子の染め手の気配・役牌の刻子（發）']);
  });

  it('リーチの人も対象の人もいなければ null（タブを出さない）。副露が 1 つで気配も無い人だけでも null', () => {
    expect(dangerBoxOf(decisionOf({}), mine)).toBeNull();
    expect(dangerBoxOf(decisionOf({ melds: melds(1, [pon('F')]) }), mine)).toBeNull();
  });

  it('リーチの人と対象の人がいるとき、リーチの人の欄が先、そのあとに行（リーチの人は行に出ない）', () => {
    const box = dangerBoxOf(
      decisionOf({ melds: opens, riichi: ['none', 'none', 'accepted', 'none'], riichiOrder: [2] }),
      mine,
    );
    expect(box?.sections.map((s) => s.who)).toEqual(['対面']);
    expect(box?.signs.map((line) => line.who)).toEqual(['上家']);
    // リーチの人が、副露も 2 つ以上あっても、行には出ず、欄のほうに出る
    const both = dangerBoxOf(
      decisionOf({ melds: melds(2, [pon('1m'), pon('5p')]), riichi: ['none', 'none', 'accepted', 'none'], riichiOrder: [2] }),
      mine,
    );
    expect(both?.sections.map((s) => s.who)).toEqual(['対面']);
    expect(both?.signs).toEqual([]);
  });

  it('切れる牌が無い判断（和了・カン）は、対象の人がいても null', () => {
    expect(dangerBoxOf(decisionOf({ melds: opens }, 'win'), { type: 'option', id: 'pass' })).toBeNull();
    expect(dangerBoxOf(decisionOf({ melds: opens }, 'kan'), { type: 'option', id: 'pass' })).toBeNull();
  });
});

// ---- 固定データ ----

const IDS = [...FX1_IDS, FX4_ID, FX5_ID] as const;

describe('E-39 副露の気配: 固定データの 7 半荘', () => {
  it('対象になる場面が実在し、どの場面でも、リーチの人・本人は行に出ない。行の文は決めた形に合う', () => {
    let scenes = 0;
    let withSign = 0;
    let withSuit = 0;
    let withYakuhai = 0;
    let signOnly = 0;
    const shape = /^(下家|対面|上家): \d副露(・(萬子|筒子|索子)の染め手の気配)?(・役牌の刻子（[東南西北白發中]([・][東南西北白發中])*）)?$/;
    for (const id of IDS) {
      const game = importReportText(loadReportText(id));
      if (!game.ok) throw new Error(game.error.message);
      for (const decision of game.value.decisions) {
        const found = openSignLinesOf(decision.board);
        scenes++;
        if (found.length === 0) continue;
        withSign++;
        let riichi = false;
        for (const line of found) {
          expect(line.text, `${id} ${decision.kyokuLabel}`).toMatch(shape);
          expect(line.seat).not.toBe(decision.board.playerId);
          expect(decision.board.riichi[line.seat]).toBe('none');
          expect(isOpenTarget(line.sign)).toBe(true);
          if (line.text.includes('染め手')) withSuit++;
          if (line.text.includes('役牌')) withYakuhai++;
          // 暗槓は副露の数に入らない: 行の副露の数は、盤面の副露のうち暗槓でないものの数
          expect(line.sign.openMelds).toBe((decision.board.melds[line.seat] ?? []).filter((meld) => meld.type !== 'ankan').length);
        }
        riichi = decision.board.riichiOrder.some((seat) => seat !== decision.board.playerId && decision.board.riichi[seat] !== 'none');
        if (!riichi) signOnly++;
      }
    }
    expect(scenes).toBeGreaterThan(1000);
    // 対象の人がいる場面があり、染め手の気配・役牌の刻子の行も、リーチの人がいない場面も含む
    expect(withSign).toBeGreaterThan(30);
    expect(withSuit).toBeGreaterThan(0);
    expect(withYakuhai).toBeGreaterThan(0);
    expect(signOnly).toBeGreaterThan(0);
  });

  it('実戦の判断で、守備のタブが出る（対象の人がいる）場面の中身が組み立てられる', () => {
    let boxes = 0;
    for (const id of IDS) {
      const game = importReportText(loadReportText(id));
      if (!game.ok) throw new Error(game.error.message);
      for (const decision of game.value.decisions) {
        const box = dangerBoxOf(decision, actualChoice(decision));
        if (box === null) continue;
        boxes++;
        expect(box.sections.length + box.signs.length).toBeGreaterThan(0);
        expect(box.sections.map((s) => s.seat)).toEqual(decision.board.riichiOrder.filter((seat) => seat !== decision.board.playerId && decision.board.riichi[seat] !== 'none'));
      }
    }
    expect(boxes).toBeGreaterThan(30);
  });
});
