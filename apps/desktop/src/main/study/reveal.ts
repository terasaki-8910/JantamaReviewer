/**
 * 答え合わせの内容（AI の候補・確率・受け入れ枚数の比較）を、答えを出したときに初めて組み立てる（U-1）。
 * 答える前の画面には、ここで作るものを一切出さない（呼ぶ側が、答え合わせを押すまで呼ばない）。
 *
 * 組み立てるのは、エンジンの計算をつなぎ、画面に出す順に並べるだけ:
 * - AI の評価の棒: 候補の確率の高い順に、上位 4 つと、自分の答え・実戦の行動（どれにも当たらない自分の答えは、確率 0 で足す）
 * - 受け入れ枚数の行（打牌の判断だけ）: 自分・実戦・AI・最大。同じ打牌の行は 1 つにまとめる（E-22: 手牌だけの枚数と残り）
 * - 一言: 自分の打牌と AI の打牌の、向聴数と受け入れ枚数の比べ方
 * - 役の欄（F13。R14-1）: 自分・実戦・AI の行動ごとの、確定している役・近い役・役無しの警告（エンジンの `yakuBoxOf`）
 * - 待ちと打点（F14。R15-2・R15-3）: 聴牌になる行動ごとの、待ち牌ごとの役・飜・符・点数と待ちの形（エンジンの `waitBoxOf`）。タブ「待ちと打点」の中身
 * - 守備の目安（F14。R15-2・R15-4・R16-6）: 他家のリーチがある場面の、切れる牌ごとの現物・スジ・壁・字牌・無スジと、副露の気配の 1 行（エンジンの `dangerBoxOf`）。タブ「守備」の中身
 */
import {
  actualChoice,
  answerOptions,
  choiceProbability,
  compareDiscardUkeire,
  dangerBoxOf,
  discardCandidates,
  findDiscardDetail,
  followAfterTwoShanten,
  isCorrectAnswer,
  plainTile,
  sameChoice,
  shantenTag,
  topChoice,
  yakuBoxOf,
  type AnswerOption,
  type DangerBox,
  type Decision,
  type DiscardDetail,
  type QuizChoice,
  type Tile,
  type TwoShantenFollow,
  type WaitBox,
  type YakuBox,
  waitBoxOf,
} from '@jantama/engine';

export type BarMark = '自分' | '実戦' | 'AI';
export type BarKind = 'you' | 'top' | 'act' | 'other';

/** AI の評価の棒 1 本（打牌は牌、ほかの判断は答えのボタン）。 */
export interface Bar {
  key: string;
  tags: BarMark[];
  kind: BarKind;
  tile: Tile | null;
  option: AnswerOption | null;
  probability: number;
}

export type UkeireTag = '自分' | '実戦' | 'AI' | '最大';

/** 受け入れ枚数の行 1 つ。 */
export interface UkeireRow {
  tags: UkeireTag[];
  tile: Tile;
  detail: DiscardDetail;
  color: 'you' | 'top' | 'act' | 'max';
  /** いちばん進む打牌より向聴数が多い（枚数で比べられない）。 */
  worse: boolean;
}

export interface UkeireBox {
  rows: UkeireRow[];
  /** 棒の長さをそろえる、行の受け入れ枚数の最大。 */
  maxCount: number;
  /** いちばん進む打牌の向聴数。 */
  minShanten: number;
  anyWorse: boolean;
  /** 自分の打牌と AI の打牌の比べ方の一言。AI の 1 位が打牌でないときは空。 */
  takeaway: string;
  /** 天鳳牌理のリンク（ツモ牌を含む手牌）。 */
  pairiUrl: string;
  /** 判断の手牌（ツモ牌を含む）。2 向聴からの先の計算に使う。 */
  tiles: Tile[];
  /** 切る牌の種類ごとの結果（行の中の牌の結果を引く）。 */
  details: DiscardDetail[];
}

export interface RevealModel {
  /** AI が自分の答えに付けた確率。 */
  probability: number;
  /** 正解か（基準以上）。 */
  correct: boolean;
  bars: Bar[];
  /** 実戦の打牌（打牌の判断で、実戦が打牌のとき）。 */
  actualTile: Tile | null;
  /** AI の 1 位の打牌（打牌の判断で、1 位が打牌のとき）。 */
  topTile: Tile | null;
  ukeire: UkeireBox | null;
  /** 欄「役」の中身。比べる行動が無い判断（カン・和了）は null。 */
  yaku: YakuBox | null;
  /** タブ「待ちと打点」の中身。聴牌になる行動が無い場面は null（タブを出さない）。 */
  waits: WaitBox | null;
  /** タブ「守備」の中身。他家のリーチも副露の気配の 1 行の人も無い場面と、切れる牌が無い判断は null（タブを出さない）。 */
  danger: DangerBox | null;
}

/** 確率の書き方: 97.72%、0.01% 未満は <0.01%。 */
export function formatProbability(probability: number): string {
  const percent = probability * 100;
  return percent >= 0.01 ? `${percent.toFixed(2)}%` : '<0.01%';
}

function barKind(tags: readonly BarMark[]): BarKind {
  if (tags.includes('自分')) return 'you';
  if (tags.includes('AI')) return 'top';
  if (tags.includes('実戦')) return 'act';
  return 'other';
}

/** 自分の打牌と AI の打牌の比べ方の一言（9回目のサンプルの文言）。 */
function takeawayOf(mine: DiscardDetail, ai: DiscardDetail | undefined, same: boolean): string {
  if (ai === undefined) return '';
  if (same) return 'AIと同じ打牌です';
  if (mine.shanten > ai.shanten) {
    return `自分の打牌は${shantenTag(mine.shanten)}、AIの打牌は${shantenTag(ai.shanten)} → 向聴数で差がついた`;
  }
  if (mine.shanten < ai.shanten) {
    return '自分の打牌のほうが向聴数が少ない → 受け入れ枚数ではなく、守備・打点・形の質で差がついた';
  }
  if (ai.ukeire < mine.ukeire) return 'AIの打牌のほうが受け入れが少ない → 形の質・打点・守備のどれかで差がついた';
  if (ai.ukeire === mine.ukeire) return '受け入れ枚数は同じ → 形の質・打点・守備のどれかで差がついた';
  return 'AIの打牌のほうが受け入れが多い → 受け入れ枚数で差がついた';
}

function discardBars(decision: Decision, choice: Extract<QuizChoice, { type: 'dahai' }>): Bar[] {
  const { entry } = decision;
  const candidates = [...discardCandidates(entry)].sort((a, b) => b.probability - a.probability);
  const actualTile = entry.actual.type === 'dahai' ? entry.actual.pai : null;
  const topAction = entry.details[0]?.action;
  const topTile = topAction?.type === 'dahai' ? topAction.pai : null;
  const mine = choice.tile;
  // 自分の答えが候補に無い（切れない牌を選んだ）ときも、棒を出す（確率は 0）
  const list = candidates.some((c) => c.tile === mine)
    ? candidates
    : [...candidates, { tile: mine, probability: 0, q: 0 }];
  const rows = list.filter((c, index) => index < 4 || c.tile === mine || c.tile === actualTile);
  return rows.map((c) => {
    const tags: BarMark[] = [];
    if (c.tile === mine) tags.push('自分');
    if (c.tile === actualTile) tags.push('実戦');
    if (c.tile === topTile) tags.push('AI');
    return { key: `dahai:${c.tile}`, tags, kind: barKind(tags), tile: c.tile, option: null, probability: c.probability };
  });
}

/** 打牌以外の判断の評価の行。`choice` は自分の答え（通して見る画面の、答える場面でない手番では無いので null）。 */
function optionBars(decision: Decision, choice: QuizChoice | null): Bar[] {
  const options = [...answerOptions(decision)].sort((a, b) => b.probability - a.probability);
  const actual = actualChoice(decision);
  const top = topChoice(decision);
  const rows = options.filter(
    (o, index) =>
      index < 4 ||
      (choice !== null && sameChoice(choice, { type: 'option', id: o.id })) ||
      sameChoice(actual, { type: 'option', id: o.id }),
  );
  return rows.map((o) => {
    const as: QuizChoice = { type: 'option', id: o.id };
    const tags: BarMark[] = [];
    if (choice !== null && sameChoice(choice, as)) tags.push('自分');
    if (sameChoice(actual, as)) tags.push('実戦');
    if (top !== null && sameChoice(top, as)) tags.push('AI');
    return { key: `option:${o.id}`, tags, kind: barKind(tags), tile: null, option: o, probability: o.probability };
  });
}

/**
 * 通して見る画面で、答える場面でない自分の判断（打牌以外）の、AI の評価の行。自分の答えが無いので、印は実戦と AI だけ。
 * 打牌の判断は、手牌の上の棒（`aiBars.ts`）で出すので、空を返す。
 */
export function browseBars(decision: Decision): Bar[] {
  return decision.kind === 'discard' ? [] : optionBars(decision, null);
}

function ukeireBox(decision: Decision, mineTile: Tile): UkeireBox | null {
  const cmp = compareDiscardUkeire(decision, mineTile);
  if (cmp === null || cmp.details.length === 0) return null;
  const { details } = cmp;
  const mine = plainTile(mineTile);
  const actualTile = cmp.actual?.tile ?? null;
  const topTile = cmp.top?.tile ?? null;
  const bestTile = cmp.best.some((o) => o.tile === mine)
    ? mine
    : topTile !== null && cmp.best.some((o) => o.tile === topTile)
      ? topTile
      : (cmp.best[0]?.tile ?? mine);
  const defs: Array<[UkeireTag, Tile | null, UkeireRow['color']]> = [
    ['自分', mine, 'you'],
    ['実戦', actualTile, 'act'],
    ['AI', topTile, 'top'],
    ['最大', bestTile, 'max'],
  ];
  const minShanten = Math.min(...details.map((d) => d.shanten));
  const merged: Array<{ tile: Tile; tags: UkeireTag[]; colors: UkeireRow['color'][] }> = [];
  for (const [tag, tile, color] of defs) {
    if (tile === null) continue;
    const found = merged.find((row) => row.tile === tile);
    if (found !== undefined) {
      found.tags.push(tag);
      found.colors.push(color);
    } else {
      merged.push({ tile, tags: [tag], colors: [color] });
    }
  }
  const rows: UkeireRow[] = [];
  for (const row of merged) {
    const detail = findDiscardDetail(details, row.tile);
    if (detail === undefined) continue;
    const color = row.colors.includes('you') ? 'you' : row.colors.includes('top') ? 'top' : row.colors.includes('act') ? 'act' : 'max';
    rows.push({ tags: row.tags, tile: row.tile, detail, color, worse: detail.shanten > minShanten });
  }
  const mineDetail = findDiscardDetail(details, mine);
  const aiDetail = topTile === null ? undefined : findDiscardDetail(details, topTile);
  const tiles = decision.board.drawn === null ? [...decision.board.hand] : [...decision.board.hand, decision.board.drawn];
  return {
    rows,
    maxCount: Math.max(1, ...rows.map((r) => r.detail.ukeire)),
    minShanten,
    anyWorse: rows.some((r) => r.worse),
    takeaway: mineDetail === undefined ? '' : takeawayOf(mineDetail, aiDetail, topTile !== null && topTile === mine),
    pairiUrl: cmp.pairiUrl,
    tiles,
    details,
  };
}

/** 答え合わせの内容。`threshold` は、正解とする確率の下限（大きな不一致の基準と同じ。既定 0.05）。 */
export function buildReveal(decision: Decision, choice: QuizChoice, threshold?: number): RevealModel {
  const probability = choiceProbability(decision, choice);
  const correct = isCorrectAnswer(probability, threshold);
  if (decision.kind === 'discard' && choice.type === 'dahai') {
    const topAction = decision.entry.details[0]?.action;
    return {
      probability,
      correct,
      bars: discardBars(decision, choice),
      actualTile: decision.entry.actual.type === 'dahai' ? decision.entry.actual.pai : null,
      topTile: topAction?.type === 'dahai' ? topAction.pai : null,
      ukeire: ukeireBox(decision, choice.tile),
      yaku: yakuBoxOf(decision, choice),
      waits: waitBoxOf(decision, choice),
      danger: dangerBoxOf(decision, choice),
    };
  }
  return {
    probability,
    correct,
    bars: optionBars(decision, choice),
    actualTile: null,
    topTile: null,
    ukeire: null,
    yaku: yakuBoxOf(decision, choice),
    waits: waitBoxOf(decision, choice),
    danger: dangerBoxOf(decision, choice),
  };
}

/**
 * 2 向聴からの先（E-23）。行を開いたときに初めて数える。切ったあとが 2 向聴でなければ null。
 * `tiles` は判断の手牌（ツモ牌を含む）、`discard` は切る牌。
 */
export function followOf(tiles: readonly Tile[], discard: Tile): TwoShantenFollow | null {
  const index = tiles.findIndex((t) => plainTile(t) === plainTile(discard));
  if (index < 0) return null;
  return followAfterTwoShanten(tiles.filter((_, i) => i !== index));
}
