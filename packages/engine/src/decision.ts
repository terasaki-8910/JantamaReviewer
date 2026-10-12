/**
 * 判断（Decision）と、その種類・タグ（E-8）。
 *
 * 種類（kind）は候補の行動から決める。タグは、向聴数（場面の手で数える。E-21）・鳴き・押し引き・序盤。
 * 画面では自動で付けたものをユーザーが直せる（F3）。
 */
import type { BoardState } from './replay';
import type { ReportDetail, ReportEntry } from './report-types';
import { sceneShanten } from './scene-shanten';

/**
 * 判断の種類。
 * - discard: 打牌（ツモのあとに切る牌を選ぶ。九種九牌の選択もここ）
 * - call: 他家の打牌への鳴き（チー・ポン・大明槓）かスルー
 * - riichi: リーチするかどうか
 * - win: 和了（ツモ・ロン）するかどうか
 * - kan: 暗槓・加槓するかどうか
 */
export type DecisionKind = 'discard' | 'call' | 'riichi' | 'win' | 'kan';

/**
 * 候補の行動から判断の種類を決める。いくつか当てはまるときは、和了・リーチ・鳴き・カン・打牌の順に優先する
 * （analysis/maka-fit/features.py の kind と同じ）。
 * 鳴きの判断には、スルー（none）が必ず候補に入る。大明槓の候補は ankan の形で入っているが、
 * ポンの候補も一緒にあるので、鳴きに分類される。
 */
export function classifyDecisionKind(details: readonly ReportDetail[]): DecisionKind {
  const types = new Set(details.map((d) => d.action.type));
  if (types.has('hora')) return 'win';
  if (types.has('reach')) return 'riichi';
  if (types.has('chi') || types.has('pon') || types.has('daiminkan') || types.has('none')) return 'call';
  if (types.has('ankan') || types.has('kakan')) return 'kan';
  return 'discard';
}

/** 鳴きの判断（チー・ポン・スルー）。 */
export const TAG_CALL = '鳴き';
/** 他家にリーチがある（押すか引くかの判断）。 */
export const TAG_PUSH_PULL = '押し引き';
/** 序盤（6巡目まで）。 */
export const TAG_EARLY = '序盤';
/** 序盤とする巡目の上限。 */
export const EARLY_JUNME_LIMIT = 6;

/** 向聴数のタグ。0 以下は聴牌。例: 2向聴。 */
export function shantenTag(shanten: number): string {
  return shanten <= 0 ? '聴牌' : `${shanten}向聴`;
}

/** 他家（本人以外）のだれかがリーチを宣言しているか。宣言牌がまだ通っていなくても数える。 */
export function opponentHasRiichi(board: Pick<BoardState, 'playerId' | 'riichi'>): boolean {
  return board.riichi.some((state, seat) => seat !== board.playerId && state !== 'none');
}

/**
 * 判断のタグ。順に、向聴数、鳴き（鳴きの判断）、押し引き（他家のリーチ）、序盤（junme が 6 以下）。
 * 向聴数は、その場面の手で数える（E-21。打牌の判断はツモったあとの14枚から切る牌ごとの最小、鳴きの判断は鳴く前の13枚。
 * 結果 JSON の `shanten` は、ツモる前の手のものなので使わない）ので、盤面の手牌とツモ牌を渡す。
 */
export function classifyTags(
  entry: Pick<ReportEntry, 'junme'>,
  kind: DecisionKind,
  board: Pick<BoardState, 'playerId' | 'riichi' | 'hand' | 'drawn'>,
): string[] {
  const tags = [shantenTag(sceneShanten(board))];
  if (kind === 'call') tags.push(TAG_CALL);
  if (opponentHasRiichi(board)) tags.push(TAG_PUSH_PULL);
  if (entry.junme <= EARLY_JUNME_LIMIT) tags.push(TAG_EARLY);
  return tags;
}

/** 取り込んだ半荘の中の 1 判断。 */
export interface Decision {
  /** 半荘の中の通し番号（0 から）。 */
  index: number;
  /** 何番目の局か（review.kyokus の添字）。 */
  kyokuPosition: number;
  /** その局の中で何番目の判断か（kyoku.entries の添字）。 */
  entryIndex: number;
  /** 局の通し番号（東1局が 0）。 */
  kyoku: number;
  honba: number;
  /** 局の名前。例: 東4局、東3局1本場。 */
  kyokuLabel: string;
  /** 巡目（記録のまま）。 */
  junme: number;
  /** mjai_log の中で、この判断の直前に起きた event の位置（盤面はこの event を進めた後）。 */
  eventIndex: number;
  /** 記録（mjai-reviewer の判断）そのまま。 */
  entry: ReportEntry;
  /** この判断の時点の盤面。 */
  board: BoardState;
  kind: DecisionKind;
  /** 場面の向聴数（E-21。0 は聴牌）。`tags` の先頭は、この数の言い方。記録の `entry.shanten` とは違うことがある。 */
  shanten: number;
  tags: string[];
}
