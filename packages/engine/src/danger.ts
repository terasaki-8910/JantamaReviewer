/**
 * 守備の目安（答え合わせのタブ「守備」。F14、E-39。R15-2・R15-4。提案 3）。
 *
 * 他家（いまはリーチした人）ごとに、自分が切れる牌 1 種類ずつを、5 つの 1 語に分ける。数値ではなく、**形式的な分類**で、AI（Mortal）の放銃の確率ではない。
 * majiang-ai（kobalab。MIT。Copyright (c) 2021 Satoshi Kobayashi）の suanpai.js の考え方（現物・見えていない枚数・無スジ・嵌張・壁）に沿うが、
 * 数値の計算は写さず、分類を返す自前の実装（majiang-ai は、順が食い違わないかを見る試験でだけ使う）。
 *   現物    その人の河にある牌、またはその人のリーチ宣言のあとに、だれかが切って通った牌（その人はロンできない）
 *   字牌    現物でない字牌。見えている枚数（自分の手牌・全員の河・副露・ドラ表示牌）を添える
 *   スジ    数牌で、両面で待たれうる形（その牌を作る 2 枚の組）が、スジ（3 つ離れた牌が現物）か壁で、すべて消えている。1 つ以上がスジで消えている。
 *           嵌張・辺張・単騎・双碰は残る
 *   壁      スジでなく、壁（両面の組に要る牌が 4 枚見えている）だけで、両面が消えている
 *   無スジ  両面で待たれうる形が残っている
 * 見ていないもの: 副露の多い染め手・ドラ待ち・巡目・リーチ宣言牌の周り（ワンチャンス）・リーチした人の河の切り順。
 *
 * 形: 他家 1 人 × 牌 1 種類 → 分類は `classifyAgainst(opponent, kind, view)`。他家の種類（`DangerOpponent` の `kind`）ごとに、分類のしかたを持つ。
 * いまはリーチ（`'riichi'`）だけ。副露した他家への目安（染め手・役牌の仕掛けなど。R15-2 の補足）は、見本を作って決めるまで作らない
 * （足すときは、`DangerOpponent` に種類を足し、`classifyAgainst` の `switch` に 1 つ書く。タブの枠・行の形は変えずに済む）。
 *
 * タブの中身 `dangerBoxOf` は、AI の行動の印（自分・実戦・AI）を含むので、答え合わせのあとにだけ呼ぶ（U-1。呼ぶ側が決める）。
 */
import type { Decision } from './decision';
import { type AnswerOption, answerOptions, type QuizChoice } from './quiz-choice';
import type { RiverTile } from './replay';
import type { Fuuro, Seat } from './report-types';
import { type Tile, TILE_KIND_COUNT, countTiles, plainTile, sortTiles, tileKind } from './tiles';
import { visibleTileCounts } from './ukeire-remaining';
import { type YakuMark, comparedActions } from './yaku-view';

/** 5 つの分類。 */
export type DangerClass = '現物' | 'スジ' | '壁' | '字牌' | '無スジ';

/**
 * 分類を、安全な順（左ほど安全）に並べたもの。現物 < 字牌 < 壁 < スジ < 無スジ（majiang-ai の数値の順と大きく食い違わないかを試験で見る基準。E-39）。
 * 字牌・壁・スジの間の前後は、目安にすぎない（majiang-ai の数値でも、場面で入れ替わる）。
 */
export const DANGER_ORDER: readonly DangerClass[] = ['現物', '字牌', '壁', 'スジ', '無スジ'];

/** 分類 1 つと、1 行の補足。 */
export interface DangerCell {
  cls: DangerClass;
  /** 補足。例: 対面の河にある・下家のリーチ後に通った・6萬が現物・2枚見え・両面が残る・中張牌。 */
  note: string;
}

/** リーチした他家 1 人。 */
export interface RiichiOpponent {
  kind: 'riichi';
  seat: Seat;
  /** 自分から見た呼び名（上家・対面・下家）。補足の文に使う。 */
  who: string;
  /** その人の河にある牌の種類（鳴かれた牌も含む。リーチ宣言牌も含む）。 */
  river: ReadonlySet<number>;
  /** その人のリーチ宣言のあとに、だれかが切って通った牌の種類。 */
  passed: ReadonlySet<number>;
}

/** 目安の対象になる他家。いまはリーチした人だけ（副露した他家は、見本で決めてから足す）。 */
export type DangerOpponent = RiichiOpponent;

/** 他家に依らない、場に見えている牌の数。 */
export interface DangerView {
  /** 種類ごと（長さ 34）の、自分の手牌にも場にも見えていない枚数。 */
  unseen: readonly number[];
}

const RELATION = ['自分', '下家', '対面', '上家'] as const;

/** 自分の席 `me` から見た、席 `seat` の呼び名（自分・下家・対面・上家）。 */
export function seatRelation(me: Seat, seat: Seat): string {
  return RELATION[(((seat - me) % 4) + 4) % 4] as string;
}

const HONOR_NAMES = ['東', '南', '西', '北', '白', '發', '中'] as const;
const SUIT_NAMES = ['萬', '筒', '索'] as const;

/** 補足の文に出す牌の呼び名。例: 6萬・8筒・東。 */
function kindName(kind: number): string {
  if (kind >= 27) return HONOR_NAMES[kind - 27] as string;
  return `${(kind % 9) + 1}${SUIT_NAMES[Math.floor(kind / 9)]}`;
}

/** リーチした人 1 人に対する、切る牌 `kind`（種類）の分類。 */
function classifyRiichi(opponent: RiichiOpponent, kind: number, view: DangerView): DangerCell {
  const { river, passed, who } = opponent;
  if (river.has(kind)) return { cls: '現物', note: `${who}の河にある` };
  if (passed.has(kind)) return { cls: '現物', note: `${who}のリーチ後に通った` };
  const unseen = view.unseen;
  const seen = 4 - (unseen[kind] as number);
  if (kind >= 27) return { cls: '字牌', note: `${seen}枚見え` };
  const suit = Math.floor(kind / 9);
  const n = (kind % 9) + 1;
  const at = (num: number) => suit * 9 + num - 1;
  const safe = (k: number) => river.has(k) || passed.has(k);
  // 両面で待たれうる形。左の組（n-2, n-1）は n-3 と n を待つ（n-3 が 1 以上のときだけ両面。n-2 が 1 の組は 3 の辺張）。
  // 右の組（n+1, n+2）は n と n+3 を待つ（n+3 が 9 以下のときだけ両面）
  const sides: Array<{ suji: number; need: [number, number] }> = [];
  if (n >= 4) sides.push({ suji: at(n - 3), need: [at(n - 2), at(n - 1)] });
  if (n <= 6) sides.push({ suji: at(n + 3), need: [at(n + 1), at(n + 2)] });
  const notes: string[] = [];
  let usedSuji = false;
  let allClosed = true;
  for (const side of sides) {
    const dead = side.need.find((k) => (unseen[k] as number) === 0);
    if (safe(side.suji)) {
      usedSuji = true;
      notes.push(`${kindName(side.suji)}が現物`);
    } else if (dead !== undefined) {
      notes.push(`${kindName(dead)}が4枚見え`);
    } else {
      allClosed = false;
    }
  }
  if (allClosed) return { cls: usedSuji ? 'スジ' : '壁', note: notes.join('・') };
  return { cls: '無スジ', note: n >= 4 && n <= 6 ? '中張牌' : '両面が残る' };
}

/**
 * 他家 1 人に対する、切る牌 `kind`（種類）の分類。他家の種類ごとの数え方に分ける
 * （いまはリーチだけ。副露した他家は、見本で決めたあとに、`DangerOpponent` と、ここの `switch` に足す）。
 */
export function classifyAgainst(opponent: DangerOpponent, kind: number, view: DangerView): DangerCell {
  switch (opponent.kind) {
    case 'riichi':
      return classifyRiichi(opponent, kind, view);
  }
}

/** 分類の結果 1 行（切る牌 1 種類）。 */
export interface DangerRow {
  /** 切る牌（印の付いた牌はその牌、無ければ赤でない牌を先に）。 */
  tile: Tile;
  /** 牌の種類（0..33）。 */
  kind: number;
  /** 比べる行動の印（自分・実戦・AI）。無ければ空。 */
  tags: YakuMark[];
  cls: DangerClass;
  note: string;
}

/** リーチした人 1 人の欄。 */
export interface DangerSection {
  seat: Seat;
  /** 自分から見た呼び名（上家・対面・下家）。 */
  who: string;
  /** その人の河（切った順。鳴かれた牌も含む）。 */
  river: RiverTile[];
  /** 切る牌ごとの分類（手牌の並びの順）。 */
  rows: DangerRow[];
  /** 比べる行動（印の付いた打牌）の分類。見出しの行に出す。 */
  compared: DangerRow[];
  /** 切れる牌のうち、現物（見出しの行の「現物: 7p・9p」）。 */
  genbutsu: Tile[];
}

export interface DangerBox {
  /** リーチを宣言した順。 */
  sections: DangerSection[];
  /** 鳴いたあとに切れる牌の一覧か（鳴きの判断）。打牌の印は付かない。 */
  afterCall: boolean;
}

/** 手牌から牌 1 枚を抜く（その牌そのもの、無ければ同じ種類）。無ければ null。 */
function removeOne(tiles: readonly Tile[], tile: Tile): Tile[] | null {
  const out = [...tiles];
  let at = out.indexOf(tile);
  if (at < 0) at = out.findIndex((t) => tileKind(t) === tileKind(tile));
  if (at < 0) return null;
  out.splice(at, 1);
  return out;
}

/**
 * 鳴いた直後に切れない牌の種類（喰い替え）。鳴いた牌と同じ種類（現物の喰い替え）と、チーのときは、鳴いた牌と手牌から出した 2 枚の並びの、
 * 反対側の隣の牌（スジの喰い替え。3 を 4・5 でチーしたら 6、6 を 4・5 でチーしたら 3）。ポンは同じ種類だけ。
 */
export function kuikaeKinds(meld: Fuuro): number[] {
  if (meld.type !== 'chi' && meld.type !== 'pon') return [];
  const called = tileKind(meld.pai);
  if (meld.type === 'pon') return [called];
  const kinds = meld.consumed.map(tileKind).sort((a, b) => a - b);
  const low = kinds[0] as number;
  const high = kinds[1] as number;
  const out = [called];
  const suit = Math.floor(called / 9);
  if (called < low && Math.floor((high + 1) / 9) === suit && high + 1 < 27) out.push(high + 1);
  if (called > high && Math.floor((low - 1) / 9) === suit && low - 1 >= 0) out.push(low - 1);
  return out;
}

/** 切れる牌を、種類ごとに 1 つにして、手牌の並びで返す。`prefer` に同じ種類の牌があれば、その牌（赤五）を使う。 */
function distinctByKind(tiles: readonly Tile[], prefer: readonly Tile[]): Tile[] {
  const out: Tile[] = [];
  const seen = new Set<number>();
  for (const tile of sortTiles(tiles)) {
    const kind = tileKind(tile);
    if (seen.has(kind)) continue;
    seen.add(kind);
    const exact = prefer.find((p) => tileKind(p) === kind && tiles.includes(p));
    const plain = tiles.includes(plainTile(tile)) ? plainTile(tile) : tile;
    out.push(exact ?? plain);
  }
  return out;
}

const MARK_ORDER: readonly YakuMark[] = ['自分', '実戦', 'AI'];

/** 比べる打牌（印つき）。打牌の判断は比べる行動の打牌、リーチの判断は実戦（リーチしなかったときの打牌）と AI の打牌。 */
function markedDiscards(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, mine: QuizChoice): Array<{ tile: Tile; tags: YakuMark[] }> {
  const out: Array<{ tile: Tile; tags: YakuMark[] }> = [];
  const add = (tile: Tile, tag: YakuMark) => {
    const found = out.find((o) => tileKind(o.tile) === tileKind(tile));
    if (found === undefined) out.push({ tile, tags: [tag] });
    else if (!found.tags.includes(tag)) found.tags.push(tag);
  };
  if (decision.kind === 'discard') {
    for (const { choice, tags } of comparedActions(decision, mine)) {
      if (choice.type === 'dahai') for (const tag of tags) add(choice.tile, tag);
    }
  } else if (decision.kind === 'riichi') {
    const { entry } = decision;
    if (entry.actual.type === 'dahai') add(entry.actual.pai, '実戦');
    if (entry.expected.type === 'dahai') add(entry.expected.pai, 'AI');
  }
  return out.map((o) => ({ tile: o.tile, tags: MARK_ORDER.filter((m) => o.tags.includes(m)) }));
}

/** 鳴きの判断で比べるチー・ポン（比べる行動のうち、鳴く牌のあるもの）。 */
function comparedCalls(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, mine: QuizChoice): AnswerOption[] {
  const options = answerOptions(decision);
  const out: AnswerOption[] = [];
  for (const { choice } of comparedActions(decision, mine)) {
    if (choice.type !== 'option') continue;
    const option = options.find((o) => o.id === choice.id);
    if (option !== undefined && (option.kind === 'chi' || option.kind === 'pon') && option.called !== null) out.push(option);
  }
  return out;
}

/** 自分が切れる牌（種類ごとに 1 つ）と、その印。切れる牌が無い判断（和了・カン）は null。 */
function discardTilesOf(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, mine: QuizChoice): { tiles: Tile[]; marked: Array<{ tile: Tile; tags: YakuMark[] }>; afterCall: boolean } | null {
  const { board } = decision;
  const own = board.drawn === null ? [...board.hand] : [...board.hand, board.drawn];
  if (decision.kind === 'discard' || decision.kind === 'riichi') {
    const marked = markedDiscards(decision, mine);
    // 鳴いた直後の打牌は、喰い替えになる牌を切れない（手番のツモが無い 3n+2 枚の手）
    const last = (board.melds[board.playerId] ?? []).at(-1);
    const banned = decision.kind === 'discard' && board.drawn === null && last !== undefined ? kuikaeKinds(last) : [];
    const tiles = distinctByKind(
      own.filter((t) => !banned.includes(tileKind(t))),
      marked.map((m) => m.tile),
    );
    return { tiles, marked, afterCall: false };
  }
  if (decision.kind !== 'call') return null;
  const union: Tile[] = [];
  for (const option of comparedCalls(decision, mine)) {
    let after: Tile[] | null = own;
    for (const t of option.use) after = after === null ? null : removeOne(after, t);
    if (after === null || option.called === null) continue;
    const meld: Fuuro = { type: option.kind === 'chi' ? 'chi' : 'pon', target: decision.entry.last_actor, pai: option.called, consumed: [...option.use] };
    const banned = kuikaeKinds(meld);
    for (const t of after) if (!banned.includes(tileKind(t))) union.push(t);
  }
  return { tiles: distinctByKind(union, []), marked: [], afterCall: true };
}

/**
 * 答え合わせのタブ「守備」の中身。他家のリーチが無い場面と、切れる牌が無い判断（和了・カン）は null（タブを出さない）。
 * リーチした人ごとの欄を、宣言した順に並べる。切る牌は、打牌の判断・リーチの判断は手牌とツモ牌、鳴きの判断は、比べるチー・ポンのあとに切れる牌
 * （喰い替えになる牌は除く）。印（自分・実戦・AI）は、比べる打牌に付く（鳴きの判断では、鳴いたあとの打牌が牌譜に無いので付かない）。
 * 答え合わせのあとにだけ呼ぶ（AI の行動の印を含むため。U-1）。
 */
export function dangerBoxOf(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, mine: QuizChoice): DangerBox | null {
  const { board } = decision;
  const me = board.playerId;
  const seats = board.riichiOrder.filter((seat) => seat !== me && board.riichi[seat] !== 'none');
  if (seats.length === 0) return null;
  const choices = discardTilesOf(decision, mine);
  if (choices === null || choices.tiles.length === 0) return null;
  const own = countTiles(board.drawn === null ? [...board.hand] : [...board.hand, board.drawn]);
  const visible = visibleTileCounts(board);
  const unseen = new Array<number>(TILE_KIND_COUNT).fill(0).map((_, k) => Math.max(0, 4 - (own[k] as number) - (visible[k] as number)));
  const view: DangerView = { unseen };
  const tagsOf = (tile: Tile): YakuMark[] => choices.marked.find((m) => tileKind(m.tile) === tileKind(tile))?.tags ?? [];
  const sections = seats.map((seat): DangerSection => {
    const opponent: RiichiOpponent = {
      kind: 'riichi',
      seat,
      who: seatRelation(me, seat),
      river: new Set((board.rivers[seat] ?? []).map((r) => tileKind(r.tile))),
      passed: new Set((board.passedAfterRiichi[seat] ?? []).map(tileKind)),
    };
    const rows = choices.tiles.map((tile): DangerRow => {
      const kind = tileKind(tile);
      const cell = classifyAgainst(opponent, kind, view);
      return { tile, kind, tags: tagsOf(tile), cls: cell.cls, note: cell.note };
    });
    return {
      seat,
      who: opponent.who,
      river: [...(board.rivers[seat] ?? [])],
      rows,
      compared: rows.filter((r) => r.tags.length > 0),
      genbutsu: rows.filter((r) => r.cls === '現物').map((r) => r.tile),
    };
  });
  return { sections, afterCall: choices.afterCall };
}
