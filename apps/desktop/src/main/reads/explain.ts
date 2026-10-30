/**
 * 読み（F23）の数と文の組み立て（画面に依存しない純粋な関数）。
 * 手牌の下の数（%）・棒の長さ・他家の席の札と、手牌の牌を選んだときの吹き出しの中身（数の分解・効いた捨て牌・読みと実際の待ち）。
 * 数は `reads.json` の確率（0〜1）を、整数の % にして出す。0.5% 未満は 0。
 */
import { plainTile, tileKind, tileLabel, type BoardState, type DangerClass, type Seat, type Tile } from '@jantama/engine';

import type { OpponentReads, ReadsMoment } from '../../api/reads';
import { defenseAgainst } from './defense';

/** 画面に出す読み 1 場面ぶん: 読みの場面と、その場面の手牌を持つ盤面（守備の目安を数えるため）。 */
export interface ReadsMomentView {
  moment: ReadsMoment;
  board: BoardState;
}

/** 確率（0〜1）を整数の % にする。0.5% 未満は 0。 */
export function percentOf(probability: number): number {
  if (!Number.isFinite(probability)) return 0;
  return Math.min(100, Math.max(0, Math.round(probability * 100)));
}

/** 手牌の下の数の色を濃くする下限（10%）。それ未満は、うすい文字。 */
export const STRONG_FROM = 0.1;

/** 帯の長さが全幅になる確率（25%）。 */
export const BAR_FULL_AT = 0.25;

/** 帯の長さ（セルの幅に対する割合、0〜1）。 */
export function barRatio(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0) return 0;
  return Math.min(probability / BAR_FULL_AT, 1);
}

/** 手牌の牌の読み上げの名前に添える文（手牌の下の数のボタンの名前）。例: 「五筒 の読み: だれかが待っている確率 12%」。 */
export function cellLabel(tileName: string, probability: number): string {
  return `${tileName} の読み: だれかが待っている確率 ${percentOf(probability)}%`;
}

/** 他家の席の札の文。例: 「聴牌 62%」。 */
export function chipText(probability: number): string {
  return `聴牌 ${percentOf(probability)}%`;
}

/** 読みの説明（吹き出しの下に出す。SPEC F23）。 */
export const READS_HINT =
  '読み: 他家がその牌を待っている確率（3 人のどれか）。ロンできるか（役・フリテン）は含みません。天鳳の鳳凰卓で学習したモデル（hhim8826/mortal3-b40c192）の推定で、外れることもあります。';

/** 他家の席の札（席 → 聴牌の確率）。 */
export function tenpaiChips(moment: ReadsMoment): ReadonlyMap<number, number> {
  return new Map(moment.opponents.map((opponent) => [opponent.seat, opponent.tenpai]));
}

/** 牌 1 種類の確率。 */
function waitAt(table: readonly number[], kind: number): number {
  return table[kind] ?? 0;
}

/** 手牌の牌を選んだときの、種類 `kind` の「だれかが待っている確率」。 */
export function anyWaitOf(moment: ReadsMoment, tile: Tile): number {
  return waitAt(moment.any_wait, tileKind(tile));
}

const STEP_NAME: Readonly<Record<1 | 2 | 3, string>> = { 1: '下家', 2: '対面', 3: '上家' };

/** 卓の上の行の、他家 1 人ぶん。 */
export interface TenpaiLineItem {
  seat: number;
  name: string;
  riichi: boolean;
  percent: number;
}

/** 中央の箱が狭いときに卓の上の行に出す、他家の聴牌の確率（下家・対面・上家の順）。 */
export function tenpaiLineItems(moment: ReadsMoment): TenpaiLineItem[] {
  return [...moment.opponents]
    .sort((a, b) => a.step - b.step)
    .map((opponent) => ({ seat: opponent.seat, name: STEP_NAME[opponent.step], riichi: opponent.riichi, percent: percentOf(opponent.tenpai) }));
}

/** 牌の呼び名（数牌は 5p、字牌は漢字。赤五は普通の五）。守備の目安の欄と同じ。 */
export function readsTileText(tile: string): string {
  return tileLabel(plainTile(tile));
}

export interface ReasonLine {
  /** 「5 巡目の 5p（無ければ 13%）」 */
  text: string;
}

/** 読み直した他家（リーチか、聴牌の確率が 50% 以上）の、手牌の牌についての追加の文。 */
export interface RereadLines {
  /** 効いた捨て牌（2 つまで）。無ければ空（「大きく動かす捨て牌なし」を出す）。 */
  reasons: string[];
  /** 「7m 20% · 6s 16% · …」 */
  topWaits: string;
  /** 実際の待ち。聴牌していなかったときは null。 */
  actualWaits: string | null;
}

export interface OpponentExplain {
  seat: Seat;
  step: 1 | 2 | 3;
  /** 下家・対面・上家。 */
  name: string;
  riichi: boolean;
  /** 聴牌の確率（整数の %）。 */
  tenpai: number;
  /** この牌を待っている確率（整数の %）。 */
  wait: number;
  /** 守備の目安（リーチした他家だけ）。 */
  defense: { cls: DangerClass; note: string } | null;
  /** 読み直した他家だけ。 */
  reread: RereadLines | null;
}

export interface TileExplain {
  tile: Tile;
  /** だれかが待っている確率（整数の %）。 */
  anyWait: number;
  /** 下家・対面・上家の順。 */
  opponents: OpponentExplain[];
}

/** 読み直したか（リーチした他家か、聴牌の確率が 50% 以上の他家。`reasons` を持つのは、この他家だけ）。 */
export function wasReread(opponent: Pick<OpponentReads, 'riichi' | 'tenpai'>): boolean {
  return opponent.riichi || opponent.tenpai >= 0.5;
}

function rereadLines(opponent: OpponentReads, tile: Tile): RereadLines {
  const reasons = (opponent.reasons[plainTile(tile)] ?? []).slice(0, 2).map(
    (reason) => `${reason.turn} 巡目の ${readsTileText(reason.pai)}（無ければ ${percentOf(reason.without)}%）`,
  );
  const topWaits = opponent.top_waits.map((entry) => `${readsTileText(entry.tile)} ${percentOf(entry.p)}%`).join(' · ');
  const actual = opponent.actual_waits.map(readsTileText);
  return { reasons, topWaits, actualWaits: actual.length === 0 ? null : actual.join('・') };
}

/** 手牌の牌 `tile` の吹き出しの中身。 */
export function explainTile(view: ReadsMomentView, tile: Tile): TileExplain {
  const { moment, board } = view;
  const kind = tileKind(tile);
  const defense = defenseAgainst(board, kind);
  const opponents = [...moment.opponents]
    .sort((a, b) => a.step - b.step)
    .map((opponent): OpponentExplain => {
      const seat = opponent.seat as Seat;
      const cell = opponent.riichi ? defense.get(seat) : undefined;
      return {
        seat,
        step: opponent.step,
        name: STEP_NAME[opponent.step],
        riichi: opponent.riichi,
        tenpai: percentOf(opponent.tenpai),
        wait: percentOf(waitAt(opponent.waits, kind)),
        defense: cell === undefined ? null : { cls: cell.cls, note: cell.note },
        reread: wasReread(opponent) ? rereadLines(opponent, tile) : null,
      };
    });
  return { tile, anyWait: percentOf(waitAt(moment.any_wait, kind)), opponents };
}
