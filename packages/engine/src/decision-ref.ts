/**
 * 判断の呼び名と、結びつけを保存するための安定した鍵（F9、E-17）。
 *
 * 迷いマークを判断に結びつけた結果は、ユーザーが選び直せるように、判断の鍵として保存する。
 * 鍵は結果 JSON の中身だけで決まる（局の通し番号・本場・局の中の判断の番号）ので、同じ結果 JSON なら、
 * 何度取り込んでも・別の端末で取り込んでも同じ判断を指す。
 * 画面に出す呼び名は、「東2局1本場 6巡目 · 打牌の迷い」（`label`）と、実戦の行動「打南」（`actionLabel`）。
 */
import { type DecisionKind, classifyDecisionKind } from './decision';
import { kyokuLabel } from './kyoku';
import type { ActionEvent, MortalReport, ReportEntry, ReportKyoku } from './report-types';
import { type Tile, isRedFive, plainTile } from './tiles';

/** 判断の種類の名前。 */
const KIND_NAMES: Readonly<Record<DecisionKind, string>> = {
  discard: '打牌',
  call: '鳴き',
  riichi: 'リーチ',
  win: '和了',
  kan: 'カン',
};

/** 判断の種類を、迷いマークの見出しの言葉にする。例: 打牌の迷い、鳴きの迷い。 */
export function decisionKindLabel(kind: DecisionKind): string {
  return `${KIND_NAMES[kind]}の迷い`;
}

/** 字牌の呼び名。 */
const HONOR_NAMES: Readonly<Record<string, string>> = { E: '東', S: '南', W: '西', N: '北', P: '白', F: '發', C: '中' };

/** 牌の呼び名。数牌は 5p のまま、字牌は漢字（E は東）、赤五は 赤5p。 */
export function tileLabel(tile: Tile): string {
  const honor = HONOR_NAMES[tile];
  if (honor !== undefined) return honor;
  return isRedFive(tile) ? `赤${plainTile(tile)}` : tile;
}

/**
 * 実戦の行動の呼び名。例: 打5p・東をポン・鳴かない判断・和了。
 * 何もしない（none）は、鳴きの判断なら「鳴かない判断」、和了の判断なら「和了しない判断」。
 */
export function actionLabel(action: ActionEvent, kind: DecisionKind): string {
  switch (action.type) {
    case 'dahai':
      return `打${tileLabel(action.pai)}`;
    case 'reach':
      return 'リーチ';
    case 'chi':
      return `${tileLabel(action.pai)}をチー（${action.consumed.map(tileLabel).join(' ')}）`;
    case 'pon':
      return `${tileLabel(action.pai)}をポン`;
    case 'daiminkan':
      return `${tileLabel(action.pai)}を大明槓`;
    case 'ankan':
      return `${tileLabel(plainTile(action.consumed[0] ?? ''))}を暗槓`;
    case 'kakan':
      return `${tileLabel(action.pai)}を加槓`;
    case 'hora':
      return '和了';
    case 'ryukyoku':
      return '九種九牌';
    case 'none':
      return kind === 'win' ? '和了しない判断' : '鳴かない判断';
  }
}

/** 判断 1 つの呼び名と鍵（結びつけの候補・一覧に使う）。 */
export interface DecisionRef {
  /**
   * 安定した鍵。例: k1h1e7（局の通し番号 1・本場 1・局の中の 7 番目の判断）。
   * 結果 JSON が同じなら変わらない。保存して、あとで `findDecisionRef` で判断に戻せる。
   */
  key: string;
  /** 何番目の局か（review.kyokus の添字）。 */
  kyokuPosition: number;
  /** その局の中で何番目の判断か（kyoku.entries の添字）。 */
  entryIndex: number;
  /** 局の通し番号（東1局が 0）。 */
  kyoku: number;
  honba: number;
  /** 局の名前。例: 東2局1本場。 */
  kyokuLabel: string;
  /** 巡目（記録のまま）。 */
  junme: number;
  /** その判断の時点の残りのツモ枚数（記録のまま）。 */
  tilesLeft: number;
  kind: DecisionKind;
  /** 例: 打牌の迷い。 */
  kindLabel: string;
  /** 例: 東2局1本場 6巡目 · 打牌の迷い */
  label: string;
  /** 実戦の行動。例: 打南、東をポン、鳴かない判断、和了。 */
  actionLabel: string;
}

/** 判断の鍵。局の通し番号・本場・局の中の判断の番号から作る。 */
export function decisionKey(kyoku: number, honba: number, entryIndex: number): string {
  return `k${kyoku}h${honba}e${entryIndex}`;
}

const KEY_PATTERN = /^k(\d+)h(\d+)e(\d+)$/;

/** 鍵を、局の通し番号・本場・局の中の判断の番号に戻す。鍵の形でなければ null。 */
export function parseDecisionKey(key: string): { kyoku: number; honba: number; entryIndex: number } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  return { kyoku: Number(m[1]), honba: Number(m[2]), entryIndex: Number(m[3]) };
}

function refOf(kyoku: ReportKyoku, position: number, entryIndex: number, entry: ReportEntry): DecisionRef {
  const kind = classifyDecisionKind(entry.details);
  const name = kyokuLabel(kyoku.kyoku, kyoku.honba);
  const kindLabel = decisionKindLabel(kind);
  return {
    key: decisionKey(kyoku.kyoku, kyoku.honba, entryIndex),
    kyokuPosition: position,
    entryIndex,
    kyoku: kyoku.kyoku,
    honba: kyoku.honba,
    kyokuLabel: name,
    junme: entry.junme,
    tilesLeft: entry.tiles_left,
    kind,
    kindLabel,
    label: `${name} ${entry.junme}巡目 · ${kindLabel}`,
    actionLabel: actionLabel(entry.actual, kind),
  };
}

/** 局の位置と、局の中の判断の番号から、判断の呼び名と鍵を作る。無ければ null。 */
export function decisionRefAt(report: MortalReport, kyokuPosition: number, entryIndex: number): DecisionRef | null {
  const kyoku = report.review.kyokus[kyokuPosition];
  const entry = kyoku?.entries[entryIndex];
  if (!kyoku || !entry) return null;
  return refOf(kyoku, kyokuPosition, entryIndex, entry);
}

/** 半荘のすべての判断の呼び名と鍵（半荘の順）。「手で選ぶ」の一覧に使う。 */
export function listDecisionRefs(report: MortalReport): DecisionRef[] {
  return report.review.kyokus.flatMap((kyoku, position) => kyoku.entries.map((entry, i) => refOf(kyoku, position, i, entry)));
}

/** 保存した鍵から、この結果 JSON の判断の呼び名と鍵に戻す。鍵の形でない・この結果に無い判断なら null。 */
export function findDecisionRef(report: MortalReport, key: string): DecisionRef | null {
  const parsed = parseDecisionKey(key);
  if (!parsed) return null;
  const position = report.review.kyokus.findIndex((k) => k.kyoku === parsed.kyoku && k.honba === parsed.honba);
  return position < 0 ? null : decisionRefAt(report, position, parsed.entryIndex);
}
