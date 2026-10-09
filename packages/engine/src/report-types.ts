/**
 * mjai.ekyu.moe の結果 JSON（mjai-reviewer の出力。KillerDucky 形式）の型。
 *
 * フィールド名は JSON のとおり（snake_case）にしてある。ファイルの中身そのままの形で、
 * 計算で組み立てたもの（盤面・判断の種類など）は camelCase の別の型で持つ。
 * 構造は mjai-reviewer の src/review/mortal.rs と src/state.rs による。
 */
import type { Tile } from './tiles';

/** 席（mjai の player id。半荘の間ずっと同じ席の番号）。 */
export type Seat = 0 | 1 | 2 | 3;

/** 場風・自風。 */
export type Wind = 'E' | 'S' | 'W' | 'N';

export interface StartGameEvent {
  type: 'start_game';
  names: string[];
  kyoku_first?: number;
  aka_flag?: boolean;
}

export interface StartKyokuEvent {
  type: 'start_kyoku';
  bakaze: Wind;
  dora_marker: Tile;
  /** 場の中の局の番号（1 から 4）。 */
  kyoku: number;
  honba: number;
  kyotaku: number;
  /** 親の席。 */
  oya: Seat;
  scores: number[];
  /** 4人の配牌（13枚ずつ。全員分の牌が入っている）。 */
  tehais: Tile[][];
}

export interface TsumoEvent {
  type: 'tsumo';
  actor: Seat;
  pai: Tile;
}

export interface DahaiEvent {
  type: 'dahai';
  actor: Seat;
  pai: Tile;
  tsumogiri: boolean;
}

export interface ChiEvent {
  type: 'chi';
  actor: Seat;
  target: Seat;
  pai: Tile;
  /** 自分の手牌から出した2枚。 */
  consumed: Tile[];
}

export interface PonEvent {
  type: 'pon';
  actor: Seat;
  target: Seat;
  pai: Tile;
  /** 自分の手牌から出した2枚。 */
  consumed: Tile[];
}

export interface DaiminkanEvent {
  type: 'daiminkan';
  actor: Seat;
  target: Seat;
  pai: Tile;
  /** 自分の手牌から出した3枚。 */
  consumed: Tile[];
}

export interface AnkanEvent {
  type: 'ankan';
  actor: Seat;
  /** 4枚。 */
  consumed: Tile[];
}

export interface KakanEvent {
  type: 'kakan';
  actor: Seat;
  /** 加える牌。 */
  pai: Tile;
  /** ポンの3枚。 */
  consumed: Tile[];
}

export interface ReachEvent {
  type: 'reach';
  actor: Seat;
}

export interface ReachAcceptedEvent {
  type: 'reach_accepted';
  actor: Seat;
}

export interface DoraEvent {
  type: 'dora';
  dora_marker: Tile;
}

export interface HoraEvent {
  type: 'hora';
  actor: Seat;
  /** ロンなら放銃した席、ツモなら自分。 */
  target: Seat;
  /** 点数の増減（4席）。局の結果（end_status）と牌譜の中の和了では入っている。 */
  deltas?: number[];
  ura_markers?: Tile[];
}

export interface RyukyokuEvent {
  type: 'ryukyoku';
  deltas?: number[];
  reason?: string;
}

export interface EndKyokuEvent {
  type: 'end_kyoku';
}

export interface EndGameEvent {
  type: 'end_game';
}

/** 牌譜（mjai_log）の1件。 */
export type MjaiEvent =
  | StartGameEvent
  | StartKyokuEvent
  | TsumoEvent
  | DahaiEvent
  | ChiEvent
  | PonEvent
  | DaiminkanEvent
  | AnkanEvent
  | KakanEvent
  | ReachEvent
  | ReachAcceptedEvent
  | DoraEvent
  | HoraEvent
  | RyukyokuEvent
  | EndKyokuEvent
  | EndGameEvent;

/** 何もしない（鳴かない・ロンしない）。 */
export interface NoneAction {
  type: 'none';
}

/**
 * 判断の行動（expected・actual・候補）。
 * 候補のカンは、大明槓も加槓も暗槓の形（ankan、consumed が4枚）で入っている。
 */
export type ActionEvent =
  | DahaiEvent
  | ReachEvent
  | ChiEvent
  | PonEvent
  | DaiminkanEvent
  | AnkanEvent
  | KakanEvent
  | HoraEvent
  | RyukyokuEvent
  | NoneAction;

/** 局の結果（和了は複数あることがある。流局は1件）。deltas が入っている。 */
export type EndStatusEvent = (HoraEvent | RyukyokuEvent) & { deltas: number[] };

/** 鳴きの記録（state.fuuros）。 */
export type Fuuro =
  | { type: 'chi' | 'pon'; target: Seat; pai: Tile; consumed: Tile[] }
  | { type: 'daiminkan'; target: Seat; pai: Tile; consumed: Tile[] }
  | { type: 'kakan'; pai: Tile; previous_pon_target: Seat; previous_pon_pai: Tile; consumed: Tile[] }
  | { type: 'ankan'; consumed: Tile[] };

export interface ReportDetail {
  action: ActionEvent;
  q_value: number;
  prob: number;
}

export interface ReportEntry {
  /** 巡目。自分のツモとチー・ポンで1つずつ増える（大明槓では増えない）。 */
  junme: number;
  /** 残りのツモ枚数（配牌のあと70、ツモのたびに1つ減る）。 */
  tiles_left: number;
  /** 直前に動いた席。 */
  last_actor: Seat;
  /** 直前のツモ牌か捨て牌（自分のツモ・誰かの打牌・加槓の牌）。 */
  tile: Tile;
  state: { tehai: Tile[]; fuuros: Fuuro[] };
  at_self_chi_pon: boolean;
  at_self_riichi: boolean;
  at_opponent_kakan: boolean;
  expected: ActionEvent;
  actual: ActionEvent;
  is_equal: boolean;
  /** q_value の大きい順。 */
  details: ReportDetail[];
  /** シャンテン数（0 が聴牌）。ツモ牌を除いた閉じた手牌のもの（ツモの判断では、ツモる前の手牌）。 */
  shanten: number;
  at_furiten: boolean;
  actual_index: number;
}

export interface ReportKyoku {
  /** 東1局が 0、南1局が 4、西1局が 8。 */
  kyoku: number;
  honba: number;
  end_status: EndStatusEvent[];
  /** 点数。0 番目がレビューした本人（本人から数えて席の順に回してある）。 */
  relative_scores: number[];
  entries: ReportEntry[];
}

export interface ReportReview {
  total_reviewed: number;
  total_matches: number;
  /** Mortal の Rating（0 から 1。100 倍して表示する）。 */
  rating: number;
  temperature: number;
  kyokus: ReportKyoku[];
  relative_phi_matrix: number[][][];
  model_tag: string;
}

/** 結果 JSON 全体。ここに書いていない項目（loading_time など）は読まない。 */
export interface MortalReport {
  engine: 'Mortal';
  game_length: string;
  version: string;
  review: ReportReview;
  /** レビューした本人の席。 */
  player_id: Seat;
  /** 局ごとの牌譜（tenhou.net/6 形式）。エンジンは使わず、そのまま持つ。 */
  split_logs: unknown[];
  mjai_log: MjaiEvent[];
}
