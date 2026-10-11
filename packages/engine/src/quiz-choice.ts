/**
 * 出題の答え（F3、U-16）と、それが指す AI の候補。
 *
 * 答えは、判断の種類で形が違う:
 * - 打牌（discard）: 手牌から切る牌を 1 枚選ぶ（`{ type: 'dahai', tile }`）。AI の候補（打牌）のうち、その牌の確率が、答えの確率
 * - それ以外（鳴き・リーチ・和了・カン）: 雀魂と同じ並びのボタンから選ぶ（`{ type: 'option', id }`）。ボタンは、判断の候補の
 *   行動から作る（`answerOptions`）。ボタンの並びは、チー（組み合わせごと）・ポン・カン・リーチ・ツモ／ロン・スキップ（しない・スルー）。
 *   どの答えも、結果 JSON の候補の行動のどれかに当たる（正解かどうかは、AI がその行動に付けた確率で決まる）:
 *     - チー・ポン・カン・リーチ・和了: その行動の候補。赤五の違いで候補が分かれていても、同じ組み合わせ・同じ行動は 1 つのボタンにまとめる
 *     - スルー・しない・スキップ: 「何もしない」の候補（鳴き・ロンのとき）。無ければ（自分の手番で、リーチ・ツモ・カンをしないとき）、
 *       その行動のほかの候補（ふつうの打牌）の確率の合計
 * AI の確率は、答え合わせのあとにだけ使う（答える前の画面には出さない。U-1）。
 */
import type { Decision, DecisionKind } from './decision';
import { actionLabel, tileLabel } from './decision-ref';
import type { ActionEvent, ReportDetail, ReportEntry } from './report-types';
import { type Tile, plainTile, sortTiles, tileKind } from './tiles';

/**
 * 差の原因（U-20）。答え合わせのあとに、当てはまるものをいくつでも選ぶ（チェックボックス）。
 * `id` が保存する値（Rust の `CAUSES` と同じ）、`label` が画面の文字。
 */
export const CAUSE_CHOICES = [
  { id: 'ukeire', label: '受け入れ枚数' },
  { id: 'shape', label: '形の質' },
  { id: 'value', label: '打点' },
  { id: 'defense', label: '守備' },
  { id: 'other', label: 'その他' },
] as const;

export type CauseId = (typeof CAUSE_CHOICES)[number]['id'];

/** 保存する答え。 */
export type QuizChoice = { type: 'dahai'; tile: Tile } | { type: 'option'; id: string };

/** 答えのボタン 1 つ（打牌以外）。 */
export type AnswerOptionKind = 'chi' | 'pon' | 'kan' | 'reach' | 'hora' | 'pass';

export interface AnswerOption {
  /** 保存する鍵。chi:3s+5s（赤を区別しない）・pon・kan・reach・hora・pass。 */
  id: string;
  kind: AnswerOptionKind;
  /** ボタンの文字。チー・ポン・カン・リーチ・ツモ・ロン・スルー・スキップ・しない。 */
  label: string;
  /** 答えの言い方。例: 6sをチー（4s 5s）・東をポン・リーチしない・スルー。実戦の見出しと答え合わせに使う。 */
  text: string;
  /** 手牌から出す牌（チー・ポン・カン）。ほかは空。 */
  use: Tile[];
  /** 鳴く牌（他家の打牌。チー・ポン・カンのとき。無いときは null）。 */
  called: Tile | null;
  /** AI がこの答えに付けた確率（この答えが指す候補の合計）。答え合わせのあとにだけ使う。 */
  probability: number;
}

/** 打牌の候補 1 つ（同じ牌の候補は 1 つにまとめる）。 */
export interface DiscardCandidate {
  tile: Tile;
  probability: number;
  q: number;
}

const PASS_LABEL: Readonly<Record<DecisionKind, string>> = {
  call: 'スルー',
  win: 'スキップ',
  riichi: 'しない',
  kan: 'しない',
  discard: 'しない',
};

const PASS_TEXT: Readonly<Record<DecisionKind, string>> = {
  call: 'スルー',
  win: 'スキップ',
  riichi: 'リーチしない',
  kan: 'カンしない',
  discard: 'しない',
};

/** チーの組み合わせの鍵（手牌から出す 2 枚。赤五は普通の五として）。 */
function chiId(consumed: readonly Tile[]): string {
  return `chi:${sortTiles(consumed.map(plainTile)).join('+')}`;
}

/** 鳴きの選択肢を並べるときの順（手牌から出す牌の小さいほうから）。 */
function useOrder(use: readonly Tile[]): number[] {
  return use.map(tileKind).sort((a, b) => a - b);
}

function compareUse(a: readonly Tile[], b: readonly Tile[]): number {
  const x = useOrder(a);
  const y = useOrder(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** 判断の候補の行動が、どの答えのボタンに入るか（`pass` は「何もしない」。打牌・九種九牌などもここ）。 */
function optionIdOfAction(action: ActionEvent): string {
  switch (action.type) {
    case 'chi':
      return chiId(action.consumed);
    case 'pon':
      return 'pon';
    case 'daiminkan':
    case 'ankan':
    case 'kakan':
      return 'kan';
    case 'reach':
      return 'reach';
    case 'hora':
      return 'hora';
    default:
      return 'pass';
  }
}

/** 他家の打牌への判断のとき、鳴く牌（画面では、手牌の右に離して置く）。自分の手番の判断なら null。 */
export function calledTileOf(decision: Pick<Decision, 'entry' | 'board'>): Tile | null {
  const { entry, board } = decision;
  return entry.last_actor !== board.playerId && !entry.at_self_chi_pon && !entry.at_self_riichi ? entry.tile : null;
}

/**
 * 打牌以外の判断（鳴き・リーチ・和了・カン）の、答えのボタン。並びは、チー（小さい組み合わせから）・ポン・カン・リーチ・ツモ／ロン・
 * スキップ（しない・スルー）。打牌の判断には空を返す。
 */
export function answerOptions(decision: Pick<Decision, 'kind' | 'entry' | 'board'>): AnswerOption[] {
  if (decision.kind === 'discard') return [];
  const { entry } = decision;
  const called = calledTileOf(decision);
  const calledText = called === null ? '' : tileLabel(called);
  const groups = new Map<string, { details: ReportDetail[]; probability: number }>();
  let none = 0;
  let hasNone = false;
  let other = 0;
  for (const detail of entry.details) {
    const id = optionIdOfAction(detail.action);
    if (id === 'pass') {
      if (detail.action.type === 'none') {
        hasNone = true;
        none += detail.prob;
      } else {
        other += detail.prob;
      }
      continue;
    }
    const group = groups.get(id) ?? { details: [], probability: 0 };
    group.details.push(detail);
    group.probability += detail.prob;
    groups.set(id, group);
  }

  const options: AnswerOption[] = [];
  for (const [id, group] of groups) {
    const first = (group.details[0] as ReportDetail).action;
    if (first.type === 'chi') {
      const use = sortTiles(first.consumed);
      options.push({
        id,
        kind: 'chi',
        label: 'チー',
        text: `${calledText}をチー（${use.map(tileLabel).join(' ')}）`,
        use,
        called,
        probability: group.probability,
      });
    } else if (first.type === 'pon') {
      options.push({
        id,
        kind: 'pon',
        label: 'ポン',
        text: `${calledText}をポン`,
        use: sortTiles(first.consumed),
        called,
        probability: group.probability,
      });
    } else if (first.type === 'daiminkan' || first.type === 'ankan' || first.type === 'kakan') {
      options.push({
        id,
        kind: 'kan',
        label: 'カン',
        text: called === null ? 'カン' : `${calledText}をカン`,
        use: first.type === 'kakan' ? [first.pai] : sortTiles(first.consumed),
        called,
        probability: group.probability,
      });
    } else if (first.type === 'reach') {
      options.push({ id, kind: 'reach', label: 'リーチ', text: 'リーチ', use: [], called: null, probability: group.probability });
    } else if (first.type === 'hora') {
      const own = first.actor === first.target;
      options.push({
        id,
        kind: 'hora',
        label: own ? 'ツモ' : 'ロン',
        text: own ? 'ツモ' : 'ロン',
        use: [],
        called: null,
        probability: group.probability,
      });
    }
  }
  const rank: Record<AnswerOptionKind, number> = { chi: 0, pon: 1, kan: 2, reach: 3, hora: 4, pass: 5 };
  options.sort((a, b) => rank[a.kind] - rank[b.kind] || compareUse(a.use, b.use));
  options.push({
    id: 'pass',
    kind: 'pass',
    label: PASS_LABEL[decision.kind],
    text: PASS_TEXT[decision.kind],
    use: [],
    called: null,
    probability: hasNone ? none : other,
  });
  return options;
}

/** 打牌の判断の候補（打牌だけ。同じ牌は 1 つにまとめる）。AI の評価の高い順（結果 JSON の並び）。 */
export function discardCandidates(entry: Pick<ReportEntry, 'details'>): DiscardCandidate[] {
  const merged = new Map<Tile, DiscardCandidate>();
  const order: Tile[] = [];
  for (const detail of entry.details) {
    const action = detail.action;
    if (action.type !== 'dahai') continue;
    const found = merged.get(action.pai);
    if (found === undefined) {
      merged.set(action.pai, { tile: action.pai, probability: detail.prob, q: detail.q_value });
      order.push(action.pai);
    } else {
      found.probability += detail.prob;
      found.q = Math.max(found.q, detail.q_value);
    }
  }
  return order.map((tile) => merged.get(tile) as DiscardCandidate);
}

/** 打牌の答えの確率。同じ牌の候補が無ければ、同じ種類（赤五と普通の五）の候補。それも無ければ 0。 */
export function discardProbability(entry: Pick<ReportEntry, 'details'>, tile: Tile): number {
  const candidates = discardCandidates(entry);
  const exact = candidates.find((c) => c.tile === tile);
  if (exact !== undefined) return exact.probability;
  const kind = tileKind(tile);
  return candidates.filter((c) => tileKind(c.tile) === kind).reduce((sum, c) => sum + c.probability, 0);
}

/** 答えが指す AI の候補の確率（正解かどうかは、この確率が基準以上か。`isCorrectAnswer`）。 */
export function choiceProbability(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, choice: QuizChoice): number {
  if (choice.type === 'dahai') return discardProbability(decision.entry, choice.tile);
  return answerOptions(decision).find((o) => o.id === choice.id)?.probability ?? 0;
}

/** 実戦の行動に当たる答え。実戦が打牌の判断なら打牌、そうでなければ答えのボタン。 */
export function actualChoice(decision: Pick<Decision, 'kind' | 'entry' | 'board'>): QuizChoice {
  const { actual } = decision.entry;
  if (decision.kind === 'discard' && actual.type === 'dahai') return { type: 'dahai', tile: actual.pai };
  return { type: 'option', id: optionIdOfAction(actual) };
}

/** AI の 1 位（結果 JSON の候補の先頭。q_value が最大のもの）に当たる答え。 */
export function topChoice(decision: Pick<Decision, 'kind' | 'entry' | 'board'>): QuizChoice | null {
  const top = decision.entry.details[0]?.action;
  if (top === undefined) return null;
  if (decision.kind === 'discard') return top.type === 'dahai' ? { type: 'dahai', tile: top.pai } : null;
  // ボタンの中で確率がいちばん高いもの（同じ確率なら、ボタンの並びの先）
  let best: AnswerOption | undefined;
  for (const option of answerOptions(decision)) if (best === undefined || option.probability > best.probability) best = option;
  return best === undefined ? null : { type: 'option', id: best.id };
}

/** 同じ答えか（打牌は、赤五と普通の五を同じ牌として）。 */
export function sameChoice(a: QuizChoice, b: QuizChoice): boolean {
  if (a.type === 'dahai' && b.type === 'dahai') return plainTile(a.tile) === plainTile(b.tile);
  if (a.type === 'option' && b.type === 'option') return a.id === b.id;
  return false;
}

/** 答えの言い方。例: 打3m・東をポン・6sをチー（4s 5s）・リーチしない。 */
export function choiceText(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, choice: QuizChoice): string {
  if (choice.type === 'dahai') return actionLabel({ type: 'dahai', actor: decision.board.playerId, pai: choice.tile, tsumogiri: false }, decision.kind);
  return answerOptions(decision).find((o) => o.id === choice.id)?.text ?? choice.id;
}

/** 実戦の行動の言い方（出題の見出し「実戦：打3m」に使う）。 */
export function actualText(decision: Pick<Decision, 'kind' | 'entry' | 'board'>): string {
  if (decision.kind === 'discard') return actionLabel(decision.entry.actual, decision.kind);
  return choiceText(decision, actualChoice(decision));
}
