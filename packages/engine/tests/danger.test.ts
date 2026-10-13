import { describe, expect, it } from 'vitest';

import {
  DANGER_ORDER,
  type DangerClass,
  type DangerOpponent,
  type DangerView,
  type RiichiOpponent,
  classifyAgainst,
  dangerBoxOf,
  kuikaeKinds,
  seatRelation,
} from '../src/danger';
import type { Decision } from '../src/decision';
import { importReportText } from '../src/import';
import { actualChoice } from '../src/quiz-choice';
import { type BoardState, KyokuReplayer } from '../src/replay';
import type { Fuuro, MjaiEvent, ReportEntry, Seat, StartKyokuEvent } from '../src/report-types';
import { type Tile, TILE_KIND_COUNT, parseTenhouNotation, tileKind } from '../src/tiles';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';
import { majiangAiDanger } from './helpers/majiang-ai-danger';

// F14・E-39: 答え合わせのタブ「守備」の中身（danger.ts）。他家（リーチした人）ごとに、切れる牌を 現物・スジ・壁・字牌・無スジ の 1 語に分ける。
// 1. 手で作った局面で、各分類と境目（スジは、両面の形がすべて、現物か壁で消えているときだけ。1・9 と 2・8 の端の形。赤五は普通の五）
// 2. リーチの宣言の順と、リーチ後に通った牌（盤面の riichiOrder・passedAfterRiichi。リーチ後の見逃しのフリテンで、通った牌はロンされない）
// 3. 切れる牌と印（打牌・リーチ・鳴きの判断。鳴いた直後の喰い替え）
// 4. 固定データのリーチの場面で、分類の順が majiang-ai（MIT。試験だけで使う。devDependencies）の数値の順と大きく食い違わない

/** 牌の種類の集合（天鳳の表記。例: '2m8p'）。 */
const kindsOf = (text: string): Set<number> => new Set(parseTenhouNotation(text).map(tileKind));

/** 手で作ったリーチした人。river は河、passed はリーチのあとに通った牌。 */
function riichiOf(river: string, passed = '', who = '対面', seat: Seat = 2): RiichiOpponent {
  return { kind: 'riichi', seat, who, river: kindsOf(river), passed: kindsOf(passed) };
}

/** 見えていない枚数。既定は、どの牌も 4 枚（何も見えていない）。`seen` に、見えている枚数（天鳳の表記の牌 1 つ → 枚数）を書く。 */
function viewOf(seen: Record<string, number> = {}): DangerView {
  const unseen = new Array<number>(TILE_KIND_COUNT).fill(4);
  for (const [text, count] of Object.entries(seen)) unseen[tileKind(parseTenhouNotation(text)[0] as Tile)] = 4 - count;
  return { unseen };
}

const classOf = (opponent: DangerOpponent, tile: string, view: DangerView = viewOf()) => classifyAgainst(opponent, tileKind(parseTenhouNotation(tile)[0] as Tile), view);

describe('E-39 分類: 現物', () => {
  it('その人の河にある牌は現物。補足は「（呼び名）の河にある」', () => {
    expect(classOf(riichiOf('8p'), '8p')).toEqual({ cls: '現物', note: '対面の河にある' });
    expect(classOf(riichiOf('', '', '下家'), '8p')).not.toMatchObject({ cls: '現物' });
  });

  it('リーチのあとに通った牌も現物。補足は「（呼び名）のリーチ後に通った」。河にもあるなら、河を先に書く', () => {
    expect(classOf(riichiOf('8s', '9p'), '9p')).toEqual({ cls: '現物', note: '対面のリーチ後に通った' });
    expect(classOf(riichiOf('9p', '9p'), '9p')).toEqual({ cls: '現物', note: '対面の河にある' });
  });

  it('リーチの前に、ほかの人が切って通った牌（その人の河にも、リーチ後の通りにも無い）は、現物ではない', () => {
    // その牌が見えている枚数が多くても、現物にはならない（5p は数牌。両面が残る）
    const cell = classOf(riichiOf('8s'), '5p', viewOf({ '5p': 3 }));
    expect(cell.cls).toBe('無スジ');
  });

  it('現物は、字牌でも数牌でも、見えている枚数に関わらず現物（字牌 4 枚見えでも、河にあれば現物）', () => {
    expect(classOf(riichiOf('1z'), '1z', viewOf({ '1z': 4 })).cls).toBe('現物');
    expect(classOf(riichiOf('', '7z'), '7z').cls).toBe('現物');
  });
});

describe('E-39 分類: 字牌（見えている枚数）', () => {
  it('現物でない字牌は字牌。補足は「n枚見え」（自分の手牌・河・副露・ドラ表示牌を数えた枚数）', () => {
    expect(classOf(riichiOf('1m'), '1z')).toEqual({ cls: '字牌', note: '0枚見え' });
    expect(classOf(riichiOf('1m'), '7z', viewOf({ '7z': 2 }))).toEqual({ cls: '字牌', note: '2枚見え' });
    expect(classOf(riichiOf('1m'), '5z', viewOf({ '5z': 3 }))).toEqual({ cls: '字牌', note: '3枚見え' });
  });

  it('4 枚見えている字牌も、字牌（補足は「4枚見え」）', () => {
    expect(classOf(riichiOf('1m'), '6z', viewOf({ '6z': 4 }))).toEqual({ cls: '字牌', note: '4枚見え' });
  });
});

describe('E-39 分類: スジ（両面の形がすべて、現物か壁で消えているときだけ）', () => {
  it('5 の両面は 3-4 待ち（2-5）と 6-7 待ち（5-8）。2 と 8 の両方が現物ならスジ。補足は両方の元の牌', () => {
    expect(classOf(riichiOf('2m8m'), '5m')).toEqual({ cls: 'スジ', note: '2萬が現物・8萬が現物' });
    expect(classOf(riichiOf('2m', '8m'), '5m').cls).toBe('スジ');
  });

  it('片方のスジだけでは、スジではない。中張牌（4・5・6）は「中張牌」、そのほかの数牌は「両面が残る」', () => {
    expect(classOf(riichiOf('2m'), '5m')).toEqual({ cls: '無スジ', note: '中張牌' });
    expect(classOf(riichiOf('1m'), '4m')).toEqual({ cls: '無スジ', note: '中張牌' });
    expect(classOf(riichiOf('7m'), '4m')).toEqual({ cls: '無スジ', note: '中張牌' });
    expect(classOf(riichiOf('4m'), '3m')).toEqual({ cls: '無スジ', note: '両面が残る' });
  });

  it('4 は 1 と 7 の両方、6 は 3 と 9 の両方がスジのときスジ', () => {
    expect(classOf(riichiOf('1p7p'), '4p').cls).toBe('スジ');
    expect(classOf(riichiOf('3s9s'), '6s').cls).toBe('スジ');
  });

  it('1 は 4 だけ、9 は 6 だけが元のスジ（両面の形が 1 つしかない）。2 は 5、8 は 5 だけ。3 は 6、7 は 4 だけ', () => {
    expect(classOf(riichiOf('4m'), '1m')).toEqual({ cls: 'スジ', note: '4萬が現物' });
    expect(classOf(riichiOf('6s'), '9s')).toEqual({ cls: 'スジ', note: '6索が現物' });
    expect(classOf(riichiOf('5p'), '2p')).toEqual({ cls: 'スジ', note: '5筒が現物' });
    expect(classOf(riichiOf('5p'), '8p')).toEqual({ cls: 'スジ', note: '5筒が現物' });
    expect(classOf(riichiOf('6m'), '3m')).toEqual({ cls: 'スジ', note: '6萬が現物' });
    expect(classOf(riichiOf('4m'), '7m')).toEqual({ cls: 'スジ', note: '4萬が現物' });
  });

  it('1・9・2・8 でも、スジの元の牌が現物でなければ無スジ（1・2・3・7・8・9 は「両面が残る」）', () => {
    for (const tile of ['1m', '2m', '3m', '7m', '8m', '9m']) {
      expect(classOf(riichiOf('1z'), tile), tile).toEqual({ cls: '無スジ', note: '両面が残る' });
    }
  });

  it('スジは、嵌張・辺張・単騎・双碰を消さない（3 は 6 が現物でもスジ。補足の文に、そうは書かない形式的な分類）', () => {
    // 形式的な分類: 3 の両面（4-5 待ち）だけを見る。1-2 待ちの辺張の 3 は見ない
    expect(classOf(riichiOf('6m'), '3m').cls).toBe('スジ');
    expect(classOf(riichiOf('4m'), '7m').cls).toBe('スジ');
  });

  it('スジの元の牌は、種類が同じなら、別の色の同じ数では消えない', () => {
    expect(classOf(riichiOf('4p'), '1m').cls).toBe('無スジ');
    expect(classOf(riichiOf('2p8s'), '5m').cls).toBe('無スジ');
  });
});

describe('E-39 分類: 壁（両面の形に要る牌が 4 枚見えている）', () => {
  it('両面の形の 2 枚のうち、1 種類が 4 枚見えていれば、その形は消える。スジが無く、壁だけで全部消えれば壁', () => {
    // 1 の両面は 2-3 待ち（1-4）。3 が 4 枚見え
    expect(classOf(riichiOf('1z'), '1m', viewOf({ '3m': 4 }))).toEqual({ cls: '壁', note: '3萬が4枚見え' });
    // 2 の両面は 3-4 待ち（2-5）。4 が 4 枚見え（3 は見えていない）
    expect(classOf(riichiOf('1z'), '2p', viewOf({ '4p': 4 }))).toEqual({ cls: '壁', note: '4筒が4枚見え' });
  });

  it('5 は、左の形（3-4）と右の形（6-7）の両方が壁のときだけ壁。1 つだけなら無スジ', () => {
    expect(classOf(riichiOf('1z'), '5s', viewOf({ '4s': 4, '7s': 4 }))).toEqual({ cls: '壁', note: '4索が4枚見え・7索が4枚見え' });
    expect(classOf(riichiOf('1z'), '5s', viewOf({ '4s': 4 }))).toEqual({ cls: '無スジ', note: '中張牌' });
  });

  it('壁とスジが混ざるときは、スジ（1 つ以上がスジで消えている）。補足は両方', () => {
    expect(classOf(riichiOf('2m'), '5m', viewOf({ '7m': 4 }))).toEqual({ cls: 'スジ', note: '2萬が現物・7萬が4枚見え' });
  });

  it('同じ形がスジでも壁でも消えるときは、スジを先に書く（スジで消えた形は、壁と書かない）', () => {
    // 4 の左の形（2-3）は、1 が現物（スジ）でも、2 が 4 枚見え（壁）でも消える。スジとして数える。右の形（5-6）は 5 が壁
    expect(classOf(riichiOf('1m'), '4m', viewOf({ '2m': 4, '5m': 4 }))).toEqual({ cls: 'スジ', note: '1萬が現物・5萬が4枚見え' });
  });

  it('壁は、自分の手牌の枚数も数える（自分が 2 枚持ち、河に 2 枚）。1 枚でも足りなければ、壁ではない', () => {
    expect(classOf(riichiOf('1z'), '1m', viewOf({ '2m': 4 })).cls).toBe('壁');
    expect(classOf(riichiOf('1z'), '1m', viewOf({ '2m': 3, '3m': 3 })).cls).toBe('無スジ');
  });

  it('字牌は壁にならない（字牌のまま）', () => {
    expect(classOf(riichiOf('1z'), '5z', viewOf({ '5z': 4 })).cls).toBe('字牌');
  });
});

describe('E-39 分類: 無スジ', () => {
  it('両面の形が 1 つでも残れば無スジ。見えている枚数が少ないだけでは壁にならない', () => {
    expect(classOf(riichiOf('1z'), '1m', viewOf({ '3m': 3 }))).toEqual({ cls: '無スジ', note: '両面が残る' });
    expect(classOf(riichiOf('1z'), '5p')).toEqual({ cls: '無スジ', note: '中張牌' });
  });

  it('分類の安全な順は 現物・字牌・壁・スジ・無スジ', () => {
    expect(DANGER_ORDER).toEqual(['現物', '字牌', '壁', 'スジ', '無スジ']);
  });
});

describe('E-39 呼び名', () => {
  it('自分から見た席の呼び名（下家・対面・上家）', () => {
    expect(seatRelation(0, 1)).toBe('下家');
    expect(seatRelation(0, 2)).toBe('対面');
    expect(seatRelation(0, 3)).toBe('上家');
    expect(seatRelation(2, 1)).toBe('上家');
    expect(seatRelation(3, 0)).toBe('下家');
  });
});

describe('E-39 喰い替え（鳴いた直後に切れない牌）', () => {
  const chi = (pai: Tile, consumed: Tile[]): Fuuro => ({ type: 'chi', target: 3, pai, consumed });

  it('ポンは同じ種類だけ。チーは同じ種類と、並びの反対側の隣（3 を 4・5 でチー → 3 と 6、6 を 4・5 でチー → 6 と 3）', () => {
    expect(kuikaeKinds({ type: 'pon', target: 1, pai: '7p', consumed: ['7p', '7p'] })).toEqual([tileKind('7p')]);
    expect(kuikaeKinds(chi('3m', ['4m', '5m'])).sort()).toEqual([tileKind('3m'), tileKind('6m')].sort());
    expect(kuikaeKinds(chi('6m', ['4m', '5m'])).sort()).toEqual([tileKind('3m'), tileKind('6m')].sort());
  });

  it('真ん中の嵌張や、端が数牌の端を越える形は、同じ種類だけ（5 を 4・6 でチー、3 を 1・2 でチー、7 を 8・9 でチー）', () => {
    expect(kuikaeKinds(chi('5m', ['4m', '6m']))).toEqual([tileKind('5m')]);
    expect(kuikaeKinds(chi('3m', ['1m', '2m']))).toEqual([tileKind('3m')]);
    expect(kuikaeKinds(chi('7s', ['8s', '9s']))).toEqual([tileKind('7s')]);
  });

  it('端でも、同じ色の隣の牌が元になる（9 を 7・8 でチー → 9 と 6、1 を 2・3 でチー → 1 と 4）', () => {
    expect(kuikaeKinds(chi('9p', ['7p', '8p'])).sort()).toEqual([tileKind('6p'), tileKind('9p')].sort());
    expect(kuikaeKinds(chi('1s', ['2s', '3s'])).sort()).toEqual([tileKind('1s'), tileKind('4s')].sort());
  });

  it('カン・暗槓・加槓は鳴いた直後の打牌の制限が無い（空）', () => {
    expect(kuikaeKinds({ type: 'ankan', consumed: ['1m', '1m', '1m', '1m'] })).toEqual([]);
  });
});

// ---- 盤面の再生: リーチの宣言の順と、リーチ後に通った牌 ----

const HANDS = [
  ['1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '1s', '2s', '3s', 'E', 'E'],
  ['N', 'N', 'N', '1p', '1p', '1p', '4p', '5p', '6p', '7s', '8s', '9s', 'C'],
  ['1p', '2s', '3s', '4s', '7m', '8m', '9m', 'W', 'W', 'W', '5s', '6s', '7s'],
  ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '8p'],
];

function startKyoku(tehais: string[][]): StartKyokuEvent {
  return { type: 'start_kyoku', bakaze: 'E', dora_marker: '4s', kyoku: 1, honba: 0, kyotaku: 0, oya: 0, scores: [25000, 25000, 25000, 25000], tehais };
}

/** 手牌が足りなくなる手で、牌譜の矛盾にならないよう、手牌に持っている牌だけを切る。 */
function replay(events: MjaiEvent[], playerId: Seat = 0): KyokuReplayer {
  const replayer = new KyokuReplayer(startKyoku(HANDS), playerId);
  events.forEach((e, i) => replayer.apply(e, i + 1));
  return replayer;
}

const dahai = (actor: Seat, pai: Tile): MjaiEvent => ({ type: 'dahai', actor, pai, tsumogiri: false });
const tsumo = (actor: Seat, pai: Tile): MjaiEvent => ({ type: 'tsumo', actor, pai });

describe('E-39 盤面: リーチの宣言の順（riichiOrder）', () => {
  it('宣言した順に席が入る。宣言した時点で入る（宣言牌が通る前も）。リーチしていなければ空', () => {
    expect(replay([]).snapshot().riichiOrder).toEqual([]);
    const declared = replay([tsumo(2, '2p'), { type: 'reach', actor: 2 }]).snapshot();
    expect(declared.riichiOrder).toEqual([2]);
    expect(declared.riichi[2]).toBe('declared');
    const both = replay([
      tsumo(3, '9p'),
      { type: 'reach', actor: 3 },
      dahai(3, '9p'),
      { type: 'reach_accepted', actor: 3 },
      tsumo(1, 'N'),
      { type: 'reach', actor: 1 },
      dahai(1, 'C'),
      { type: 'reach_accepted', actor: 1 },
    ]).snapshot();
    expect(both.riichiOrder).toEqual([3, 1]);
  });
});

describe('E-39 盤面: リーチのあとに通った牌（passedAfterRiichi）', () => {
  it('リーチの宣言のあとに、ほかの席（自分も）が切った牌が入る。リーチの前に切られた牌と、その人自身の宣言牌・以降の打牌（河）は入らない', () => {
    const b = replay([
      tsumo(0, 'E'),
      dahai(0, 'E'), // リーチの前: 席 2 には通っていない
      tsumo(2, '2p'),
      { type: 'reach', actor: 2 },
      dahai(2, '2p'), // 宣言牌: 自分の河（通った牌ではない）
      { type: 'reach_accepted', actor: 2 },
      tsumo(3, '9p'),
      dahai(3, '9p'), // 通った
      tsumo(0, '7m'),
      dahai(0, '7m'), // 自分の打牌も、通った
    ]).snapshot();
    expect(b.passedAfterRiichi[2]).toEqual(['9p', '7m']);
    expect(b.rivers[2]?.map((r) => r.tile)).toEqual(['2p']);
    // リーチしていない席は空
    expect(b.passedAfterRiichi[0]).toEqual([]);
    expect(b.passedAfterRiichi[1]).toEqual([]);
    expect(b.passedAfterRiichi[3]).toEqual([]);
  });

  it('リーチした席ごとに別々に持つ。後からリーチした人には、その宣言のあとの牌だけが通った牌', () => {
    const b = replay([
      tsumo(3, '9p'),
      { type: 'reach', actor: 3 },
      dahai(3, '9p'),
      { type: 'reach_accepted', actor: 3 },
      tsumo(0, '3m'),
      dahai(0, '3m'), // 席 3 にだけ通った
      tsumo(1, 'N'),
      { type: 'reach', actor: 1 },
      dahai(1, 'C'),
      { type: 'reach_accepted', actor: 1 },
      tsumo(2, '5s'),
      dahai(2, '5s'), // 席 3 にも、席 1 にも通った
    ]).snapshot();
    expect(b.passedAfterRiichi[3]).toEqual(['3m', 'C', '5s']);
    expect(b.passedAfterRiichi[1]).toEqual(['5s']);
  });

  it('同じ種類は 1 つ。赤五は赤でない表記で入る', () => {
    const hands = HANDS.map((h) => [...h]);
    hands[0] = ['5mr', '5m', '1m', '2m', '3m', '5p', '6p', '7p', '1s', '2s', '3s', 'E', 'E'];
    const r = new KyokuReplayer(startKyoku(hands), 0);
    const events: MjaiEvent[] = [tsumo(2, '2p'), { type: 'reach', actor: 2 }, dahai(2, '2p'), { type: 'reach_accepted', actor: 2 }, dahai(0, '5mr'), dahai(0, '5m')];
    events.forEach((e, i) => r.apply(e, i + 1));
    expect(r.snapshot().passedAfterRiichi[2]).toEqual(['5m']);
  });

  it('通った牌は、その人に対しては現物（補足は「リーチ後に通った」）。リーチ後の見逃しはフリテンで、その人はロンできない', () => {
    const b = replay([tsumo(2, '2p'), { type: 'reach', actor: 2 }, dahai(2, '2p'), { type: 'reach_accepted', actor: 2 }, tsumo(3, '9p'), dahai(3, '9p')]).snapshot();
    const opponent: RiichiOpponent = { kind: 'riichi', seat: 2, who: '対面', river: new Set((b.rivers[2] ?? []).map((r) => tileKind(r.tile))), passed: new Set((b.passedAfterRiichi[2] ?? []).map(tileKind)) };
    expect(classifyAgainst(opponent, tileKind('9p'), viewOf())).toEqual({ cls: '現物', note: '対面のリーチ後に通った' });
    expect(classifyAgainst(opponent, tileKind('2p'), viewOf())).toEqual({ cls: '現物', note: '対面の河にある' });
  });
});

// ---- 判断の盤面からの組み立て ----

/** 手で作った盤面（東場・自分は席 0 の親）。 */
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

const river = (tiles: string, riichiAt = -1) => parseTenhouNotation(tiles).map((tile, index) => ({ tile, tsumogiri: false, riichi: index === riichiAt, calledBy: null }));

function entryOf(actual: Tile, ai: Tile): ReportEntry {
  const action = (pai: Tile) => ({ type: 'dahai' as const, actor: 0 as Seat, pai, tsumogiri: false });
  return {
    junme: 8,
    tiles_left: 50,
    last_actor: 0,
    tile: actual,
    state: { tehai: [], fuuros: [] },
    at_self_chi_pon: false,
    at_self_riichi: false,
    at_opponent_kakan: false,
    expected: action(ai),
    actual: action(actual),
    is_equal: actual === ai,
    details: [
      { action: action(ai), q_value: 1, prob: 0.8 },
      { action: action(actual), q_value: 0.5, prob: 0.2 },
    ],
    shanten: 1,
    at_furiten: false,
    actual_index: 1,
  };
}

/** 手で作った打牌の判断。hand は 13 枚（ツモ牌を除く）、drawn がツモ牌。 */
function discardDecision(hand: string, drawn: Tile | null, board: Partial<BoardState>, actual: Tile, ai: Tile): Pick<Decision, 'kind' | 'entry' | 'board'> {
  return { kind: 'discard', entry: entryOf(actual, ai), board: boardOf({ hand: parseTenhouNotation(hand), drawn, ...board }) };
}

const mineDahai = (tile: Tile) => ({ type: 'dahai' as const, tile });

/** 手牌 13 枚（ツモ牌を除く）。 */
const HAND13 = '112m456p789s1155z';

describe('E-39 dangerBoxOf: 出る場面と出ない場面', () => {
  const hand = HAND13;

  it('他家のリーチが無い場面は null（タブを出さない）', () => {
    const decision = discardDecision(hand, '3m', {}, '3m', 'P');
    expect(dangerBoxOf(decision, mineDahai('3m'))).toBeNull();
  });

  it('自分のリーチだけの場面も null（他家のリーチが要る）', () => {
    const decision = discardDecision(hand, '3m', { riichi: ['accepted', 'none', 'none', 'none'], riichiOrder: [0] }, '3m', 'P');
    expect(dangerBoxOf(decision, mineDahai('3m'))).toBeNull();
  });

  it('宣言したが宣言牌がまだ通っていない人（declared）も、リーチした人として出す', () => {
    const decision = discardDecision(hand, '3m', { riichi: ['none', 'none', 'declared', 'none'], riichiOrder: [2], rivers: [[], [], river('1m'), []] }, '3m', 'P');
    expect(dangerBoxOf(decision, mineDahai('3m'))?.sections.map((s) => s.seat)).toEqual([2]);
  });

  it('和了・カンの判断（切る牌が無い）は null', () => {
    const base = discardDecision(hand, '3m', { riichi: ['none', 'none', 'accepted', 'none'], riichiOrder: [2] }, '3m', 'P');
    expect(dangerBoxOf({ ...base, kind: 'win' }, { type: 'option', id: 'pass' })).toBeNull();
    expect(dangerBoxOf({ ...base, kind: 'kan' }, { type: 'option', id: 'pass' })).toBeNull();
  });
});

describe('E-39 dangerBoxOf: 切れる牌の行（手牌とツモ牌、種類ごとに 1 つ、手牌の並び）と印', () => {
  const riichi = { riichi: ['none', 'none', 'accepted', 'none'] as BoardState['riichi'], riichiOrder: [2] as Seat[] };

  it('手牌とツモ牌の種類ごとに 1 行。並びは手牌の並び（萬子・筒子・索子・字牌）', () => {
    const decision = discardDecision(HAND13, '3m', { ...riichi, rivers: [[], [], river('2p'), []] }, '3m', 'P');
    const box = dangerBoxOf(decision, mineDahai('3m'));
    expect(box?.sections).toHaveLength(1);
    expect(box?.sections[0]?.rows.map((r) => r.tile)).toEqual(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', 'E', 'P']);
    expect(box?.afterCall).toBe(false);
  });

  it('印は、比べる打牌（自分・実戦・AI）の行に付く。同じ牌なら重ねる（自分・実戦）。ほかの行は空', () => {
    const decision = discardDecision(HAND13, '3m', { ...riichi, rivers: [[], [], river('2p'), []] }, '3m', 'P');
    const box = dangerBoxOf(decision, mineDahai('3m'));
    const rows = box?.sections[0]?.rows ?? [];
    expect(rows.find((r) => r.tile === '3m')?.tags).toEqual(['自分', '実戦']);
    expect(rows.find((r) => r.tile === 'P')?.tags).toEqual(['AI']);
    expect(rows.filter((r) => r.tags.length === 0)).toHaveLength(rows.length - 2);
    // 見出しの行: 比べる打牌の分類（自分・実戦、AI の順）
    expect(box?.sections[0]?.compared.map((r) => `${r.tags.join('・')}:${r.tile}`)).toEqual(['自分・実戦:3m', 'AI:P']);
    // 自分の答えが実戦と違えば、別の行
    const other = dangerBoxOf(decision, mineDahai('1m'));
    expect(other?.sections[0]?.compared.map((r) => `${r.tags.join('・')}:${r.tile}`)).toEqual(['自分:1m', '実戦:3m', 'AI:P']);
  });

  it('現物の牌の一覧は、切れる牌のうち現物のもの（手牌の並び）。河の牌とリーチ後に通った牌。無ければ空', () => {
    const decision = discardDecision(HAND13, '3m', { ...riichi, rivers: [[], [], river('5p9s'), []], passedAfterRiichi: [[], [], ['1m'], []] }, '3m', 'P');
    expect(dangerBoxOf(decision, mineDahai('3m'))?.sections[0]?.genbutsu).toEqual(['1m', '5p', '9s']);
    const honor = discardDecision(HAND13, '3m', { ...riichi, rivers: [[], [], river('1z'), []] }, '3m', 'P');
    expect(dangerBoxOf(honor, mineDahai('3m'))?.sections[0]?.genbutsu).toEqual(['E']);
    const empty = discardDecision(HAND13, '3m', { ...riichi, rivers: [[], [], river('4z'), []] }, '3m', 'P');
    expect(dangerBoxOf(empty, mineDahai('3m'))?.sections[0]?.genbutsu).toEqual([]);
  });

  it('場に見えている牌（全員の河）と自分の手牌で、壁・字牌の枚数が決まる', () => {
    // 手牌 4m 5m 6m ... とツモ 9m。4m は、河 3 枚と自分の 1 枚で 4 枚見え、7m は、河に 4 枚見え → 5m は壁
    const decision = discardDecision('456m1234p789s155z', '9m', { ...riichi, rivers: [river('4477m'), river('77m1z'), river('2s'), river('4m')] }, '5m', 'P');
    const rows = dangerBoxOf(decision, mineDahai('5m'))?.sections[0]?.rows ?? [];
    expect(rows.find((r) => r.tile === '5m')).toMatchObject({ cls: '壁', note: '4萬が4枚見え・7萬が4枚見え' });
    // 東は、他家の河に 1 枚と、自分の手牌の 0 枚…ではなく、手牌に 1 枚で、2 枚見え。字牌は壁にならない
    expect(rows.find((r) => r.tile === 'E')).toMatchObject({ cls: '字牌', note: '2枚見え' });
  });

  it('他家に鳴かれた牌は、河ではなく副露で数える（二重に数えない）。ドラ表示牌も数える', () => {
    const decision = discardDecision('456m1234p789s155z', '9m', {
      ...riichi,
      rivers: [[], [{ tile: 'E', tsumogiri: false, riichi: false, calledBy: 3 }], river('2s'), []],
      melds: [[], [], [], [{ type: 'pon', target: 1, pai: 'E', consumed: ['E', 'E'] }]],
    }, '5m', 'P');
    // 副露の 3 枚と、自分の手牌の 1 枚で 4 枚見え（河の 1 枚を足して 5 枚にならない）
    expect(dangerBoxOf(decision, mineDahai('5m'))?.sections[0]?.rows.find((r) => r.tile === 'E')?.note).toBe('4枚見え');
    const dora = discardDecision('456m1234p789s155z', '9m', { ...riichi, rivers: [[], [], river('2s'), []], doraMarkers: ['E'] }, '5m', 'P');
    expect(dangerBoxOf(dora, mineDahai('5m'))?.sections[0]?.rows.find((r) => r.tile === 'E')?.note).toBe('2枚見え');
  });

  it('赤五は普通の五として分類する。赤五しか持っていなければ、行の牌は赤五（印の付いた牌）か、赤', () => {
    const rows = (hand: string, drawn: Tile) => dangerBoxOf(discardDecision(hand, drawn, { ...riichi, rivers: [[], [], river('2m8m'), []] }, '5m', 'P'), mineDahai('5m'))?.sections[0]?.rows ?? [];
    // 赤五と普通の五を両方持つ → 1 行（赤でない五を使う）
    const both = rows('05m123p456p789s11z', '5m');
    expect(both.filter((r) => r.kind === tileKind('5m'))).toHaveLength(1);
    expect(both.find((r) => r.kind === tileKind('5m'))?.tile).toBe('5m');
    expect(both.find((r) => r.kind === tileKind('5m'))?.cls).toBe('スジ');
    // 赤五だけを持つ → 赤五の行。分類は普通の五と同じ
    const red = rows('0m122p456p789s11z1m', '4p');
    expect(red.find((r) => r.kind === tileKind('5m'))?.tile).toBe('5mr');
    expect(red.find((r) => r.kind === tileKind('5m'))?.cls).toBe('スジ');
    // 河の赤五は、普通の五の現物
    const redRiver = dangerBoxOf(discardDecision('123p456p789s11z5m', '5m', { ...riichi, rivers: [[], [], [{ tile: '5mr', tsumogiri: false, riichi: false, calledBy: null }], []] }, '5m', 'P'), mineDahai('5m'));
    expect(redRiver?.sections[0]?.rows.find((r) => r.kind === tileKind('5m'))).toMatchObject({ cls: '現物', note: '対面の河にある' });
  });
});

describe('E-39 dangerBoxOf: リーチした人が 2 人以上のとき、人ごとの欄を、宣言した順に', () => {
  it('riichiOrder の順（席の順ではない）。人ごとに、河・分類・現物が別', () => {
    const decision = discardDecision(HAND13, '3m', {
      riichi: ['none', 'accepted', 'none', 'accepted'],
      riichiOrder: [3, 1],
      rivers: [[], river('1m'), [], river('4m9s')],
    }, '3m', 'P');
    const box = dangerBoxOf(decision, mineDahai('3m'));
    expect(box?.sections.map((s) => `${s.seat}:${s.who}`)).toEqual(['3:上家', '1:下家']);
    expect(box?.sections[0]?.genbutsu).toEqual(['9s']);
    expect(box?.sections[1]?.genbutsu).toEqual(['1m']);
    expect(box?.sections[0]?.river.map((r) => r.tile)).toEqual(['4m', '9s']);
    expect(box?.sections[1]?.rows.find((r) => r.tile === '1m')).toMatchObject({ cls: '現物', note: '下家の河にある' });
    expect(box?.sections[0]?.rows.find((r) => r.tile === '1m')).toMatchObject({ cls: 'スジ', note: '4萬が現物' });
  });

  it('リーチした人が自分と他家の両方でも、他家だけ（自分の欄は出さない）', () => {
    const decision = discardDecision(HAND13, '3m', { riichi: ['accepted', 'none', 'accepted', 'none'], riichiOrder: [0, 2] }, '3m', 'P');
    expect(dangerBoxOf(decision, mineDahai('3m'))?.sections.map((s) => s.seat)).toEqual([2]);
  });
});

describe('E-39 dangerBoxOf: 鳴いた直後の打牌は、喰い替えになる牌を切れない', () => {
  it('チー（3 を 4・5 で）のあとの打牌は、3 と 6 の行が無い。ポンのあとは、鳴いた牌の種類だけ', () => {
    const chi: Fuuro = { type: 'chi', target: 3, pai: '3m', consumed: ['4m', '5m'] };
    const afterChi = discardDecision('36m2p456p789s11z', null, { riichi: ['none', 'accepted', 'none', 'none'], riichiOrder: [1], melds: [[chi], [], [], []] }, '1p', '1p');
    const rowsChi = dangerBoxOf(afterChi, mineDahai('1p'))?.sections[0]?.rows.map((r) => r.tile) ?? [];
    expect(rowsChi).not.toContain('3m');
    expect(rowsChi).not.toContain('6m');
    expect(rowsChi).toContain('2p');
    const pon: Fuuro = { type: 'pon', target: 3, pai: '3m', consumed: ['3m', '3m'] };
    const afterPon = discardDecision('36m2p456p789s11z', null, { riichi: ['none', 'accepted', 'none', 'none'], riichiOrder: [1], melds: [[pon], [], [], []] }, '1p', '1p');
    const rowsPon = dangerBoxOf(afterPon, mineDahai('1p'))?.sections[0]?.rows.map((r) => r.tile) ?? [];
    expect(rowsPon).not.toContain('3m');
    expect(rowsPon).toContain('6m');
  });

  it('ツモ牌のある打牌（鳴いた直後ではない）は、同じ手牌でも制限しない', () => {
    const chi: Fuuro = { type: 'chi', target: 3, pai: '3m', consumed: ['4m', '5m'] };
    const decision = discardDecision('36m2p456p789s11z', '2s', { riichi: ['none', 'accepted', 'none', 'none'], riichiOrder: [1], melds: [[chi], [], [], []] }, '1p', '1p');
    const rows = dangerBoxOf(decision, mineDahai('1p'))?.sections[0]?.rows.map((r) => r.tile) ?? [];
    expect(rows).toContain('3m');
    expect(rows).toContain('6m');
  });
});

// ---- 固定データ ----

function loadGame(id: string) {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value;
}

const IDS = [...FX1_IDS, FX4_ID, FX5_ID] as const;
const games = new Map(IDS.map((id) => [id, loadGame(id)]));

function decisionOf(id: (typeof IDS)[number], label: string, entry: number): Decision {
  const d = games.get(id)?.decisions.find((x) => x.kyokuLabel === label && x.entryIndex === entry);
  if (d === undefined) throw new Error(`場面が見つかりません: ${id} ${label} ${entry}`);
  return d;
}

const lineOf = (section: NonNullable<ReturnType<typeof dangerBoxOf>>['sections'][number]) => section.compared.map((r) => `${r.tags.join('・')} 打${r.tile} ${r.cls}（${r.note}）`);

describe('E-39 固定データ: 承認された見本の場面（15回目の確認シートの 4 場面）', () => {
  it('FX-5 東4局 8巡目（白をポンしたあと。下家のリーチ）: 3m は無スジ（両面が残る）、AI の 5m は無スジ（中張牌）、現物は 8p・9p', () => {
    const d = decisionOf(FX5_ID, '東4局', 8);
    const box = dangerBoxOf(d, actualChoice(d));
    expect(box?.sections).toHaveLength(1);
    const section = box?.sections[0];
    expect(section?.who).toBe('下家');
    expect(lineOf(section as never)).toEqual(['自分・実戦 打3m 無スジ（両面が残る）', 'AI 打5m 無スジ（中張牌）']);
    expect(section?.genbutsu).toEqual(['8p', '9p']);
    expect(section?.rows.find((r) => r.tile === '8p')).toMatchObject({ cls: '現物', note: '下家の河にある' });
    expect(section?.rows.find((r) => r.tile === '9p')).toMatchObject({ cls: '現物', note: '下家のリーチ後に通った' });
    expect(section?.river.filter((r) => r.riichi)).toHaveLength(1);
    expect(section?.rows.map((r) => r.tile)).toEqual(['3m', '5m', '6m', '3p', '4p', '5p', '7p', '8p', '9p']);
    expect(section?.rows.filter((r) => r.cls !== '無スジ').map((r) => r.tile)).toEqual(['8p', '9p']);
  });

  it('FX-5 東2局 8巡目（対面のリーチ）: 実戦も AI も 9m で、スジ（6萬が現物）。現物は 7p・9p', () => {
    const d = decisionOf(FX5_ID, '東2局', 8);
    const box = dangerBoxOf(d, actualChoice(d));
    const section = box?.sections[0];
    expect(section?.who).toBe('対面');
    expect(lineOf(section as never)).toEqual(['自分・実戦・AI 打9m スジ（6萬が現物）']);
    expect(section?.genbutsu).toEqual(['7p', '9p']);
    const rows = Object.fromEntries((section?.rows ?? []).map((r) => [r.tile, `${r.cls}:${r.note}`]));
    expect(rows['7p']).toBe('現物:対面の河にある');
    expect(rows['9p']).toBe('現物:対面の河にある');
  });

  it('FX-4 東1局 12巡目（上家のリーチ。2 副露の聴牌）: 切れる 5 種類は、すべて無スジ。現物は無い。実戦も AI も 8m', () => {
    const d = decisionOf(FX4_ID, '東1局', 13);
    const box = dangerBoxOf(d, actualChoice(d));
    const section = box?.sections[0];
    expect(section?.who).toBe('上家');
    expect(section?.rows).toHaveLength(5);
    expect(section?.rows.every((r) => r.cls === '無スジ')).toBe(true);
    expect(section?.genbutsu).toEqual([]);
    expect(lineOf(section as never)).toEqual(['自分・実戦・AI 打8m 無スジ（両面が残る）']);
  });

  it('FX-4 東1局 14巡目（同じリーチ）: 1s はスジ（4索が現物）。現物の 8p は、もう手牌に無い', () => {
    const d = decisionOf(FX4_ID, '東1局', 15);
    const section = dangerBoxOf(d, actualChoice(d))?.sections[0];
    expect(section?.rows.find((r) => r.tile === '1s')).toMatchObject({ cls: 'スジ', note: '4索が現物' });
    expect(section?.rows.map((r) => r.tile)).not.toContain('8p');
  });

  it('2 人がリーチしている場面（FX-1 東2局 16巡目）: 対面・下家の順（宣言した順）で、2 つの欄', () => {
    const d = decisionOf('be0a2a523fdd7758', '東2局', 19);
    const box = dangerBoxOf(d, actualChoice(d));
    expect(d.board.riichiOrder).toEqual([3, 2]);
    expect(box?.sections.map((s) => s.who)).toEqual(['対面', '下家']);
    expect(box?.sections[0]?.rows).toHaveLength(box?.sections[1]?.rows.length ?? -1);
  });

  it('鳴きの判断（リーチの場面）: 鳴いたあとに切れる牌の一覧（afterCall）。打牌の印は付かない', () => {
    const d = decisionOf('f9da87cbcd7af5e9', '南2局1本場', 8);
    expect(d.kind).toBe('call');
    const box = dangerBoxOf(d, actualChoice(d));
    expect(box?.afterCall).toBe(true);
    expect(box?.sections[0]?.rows.every((r) => r.tags.length === 0)).toBe(true);
    expect(box?.sections[0]?.compared).toEqual([]);
  });

  it('リーチの判断（する・しない）でも出る。実戦（しなかったときの打牌）と AI の打牌に印', () => {
    const d = decisionOf('f738896995c33fed', '東3局2本場', 12);
    expect(d.kind).toBe('riichi');
    const box = dangerBoxOf(d, actualChoice(d));
    expect(box?.afterCall).toBe(false);
    expect(box?.sections[0]?.compared.map((r) => r.tags.join('・'))).toEqual(['実戦・AI']);
  });
});

describe('E-39 固定データのリーチの場面: 分類の順が、majiang-ai の数値の順と大きく食い違わない', () => {
  interface Sample {
    cls: DangerClass;
    /** リーチした人すべてに対する majiang-ai の危険度の最大。 */
    value: number;
    scene: number;
  }
  const samples: Sample[] = [];
  let scenes = 0;
  for (const id of IDS) {
    const game = games.get(id)!;
    for (const d of game.decisions) {
      // 打牌の判断だけ（手牌とツモ牌 14 枚から切る。majiang-ai の数値は、その 14 枚で出す）
      if (d.kind !== 'discard') continue;
      const box = dangerBoxOf(d, actualChoice(d));
      // リーチの人の欄がある場面だけ（副露の気配の 1 行だけの場面は、分類が無いので、数値と比べない。R16-6）
      if (box === null || box.sections.length === 0) continue;
      const kyoku = game.kyokus[d.kyokuPosition] as { startIndex: number };
      const hand = d.board.drawn === null ? [...d.board.hand] : [...d.board.hand, d.board.drawn];
      const ai = majiangAiDanger(game, kyoku.startIndex, d.eventIndex, hand);
      if (ai === null) throw new Error(`majiang-ai の危険度が出ません: ${id} ${d.kyokuLabel} ${d.entryIndex}`);
      scenes++;
      const first = box.sections[0]!;
      first.rows.forEach((row, i) => {
        // リーチした人が複数なら、いちばん危ない人の分類（majiang-ai の数値も、リーチした人の最大）
        const worst = box.sections.map((s) => (s.rows[i] as { cls: DangerClass }).cls).reduce((a, c) => (DANGER_ORDER.indexOf(c) > DANGER_ORDER.indexOf(a) ? c : a));
        samples.push({ cls: worst, value: ai.get(row.kind) as number, scene: scenes });
      });
    }
  }
  const mean = (cls: DangerClass) => {
    const values = samples.filter((s) => s.cls === cls).map((s) => s.value);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  const count = (cls: DangerClass) => samples.filter((s) => s.cls === cls).length;

  it('固定データの打牌の判断のうち、他家のリーチがある場面が、十分にある（試験が空にならない）', () => {
    expect(scenes).toBeGreaterThanOrEqual(100);
    expect(count('現物')).toBeGreaterThanOrEqual(200);
    expect(count('スジ')).toBeGreaterThanOrEqual(100);
    expect(count('字牌')).toBeGreaterThanOrEqual(20);
    expect(count('無スジ')).toBeGreaterThanOrEqual(500);
    expect(count('壁')).toBeGreaterThanOrEqual(1);
  });

  it('現物は、majiang-ai の数値が全部 0（現物は、その人にとって危険度 0）', () => {
    const genbutsu = samples.filter((s) => s.cls === '現物');
    expect(genbutsu.every((s) => s.value === 0)).toBe(true);
  });

  it('分類ごとの平均が、現物 < 字牌・壁・スジ < 無スジ の順（majiang-ai の数値の平均）', () => {
    const safe = ['字牌', '壁', 'スジ'] as const;
    for (const cls of safe) {
      expect(mean('現物'), cls).toBeLessThan(mean(cls));
      expect(mean(cls), cls).toBeLessThan(mean('無スジ'));
    }
    // 無スジは、majiang-ai の数値でも、現物・スジ・字牌・壁のどの平均より大きく、それらの合わせた平均の 2 倍を超える
    const pooled = samples.filter((s) => safe.includes(s.cls as (typeof safe)[number])).map((s) => s.value);
    const pooledMean = pooled.reduce((a, b) => a + b, 0) / pooled.length;
    expect(mean('無スジ')).toBeGreaterThan(pooledMean * 2);
  });

  it('同じ場面の 2 つの牌を比べて、分類が安全な側（現物 < スジ・字牌・壁 < 無スジ の 3 段）の牌の数値が、危険な側以下になる割合が 98% 以上', () => {
    const tier = (cls: DangerClass) => (cls === '現物' ? 0 : cls === '無スジ' ? 2 : 1);
    let pairs = 0;
    let agree = 0;
    const byScene = new Map<number, Sample[]>();
    for (const s of samples) byScene.set(s.scene, [...(byScene.get(s.scene) ?? []), s]);
    for (const rows of byScene.values()) {
      for (const a of rows) {
        for (const b of rows) {
          if (tier(a.cls) >= tier(b.cls)) continue;
          pairs++;
          if (a.value <= b.value) agree++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(1000);
    expect(agree / pairs).toBeGreaterThanOrEqual(0.98);
  });
});
