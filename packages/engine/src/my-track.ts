/**
 * 自分の向聴数の推移（F14、E-41。提案 7。局の評価の表の行を開いたときの、折れ線）。1 局を牌譜（mjai の event）で追い、
 * 配牌と、自分が切るたびの場面の向聴数、聴牌になった打牌、その局の迷い・大きな不一致の場面が、横軸のどこにあるかを返す。
 *
 * - 横軸は、自分の巡目（記録のまま。mjai-reviewer の数え方で、自分のツモとチー・ポンで 1 つずつ増える。`BoardState.junme`）で、0 は配牌。
 *   点は、自分が切る（`dahai`）たびに 1 つ。切る直前の手（ツモ牌・鳴いたあとの手を含む 3n+2 枚）の場面の向聴数（E-21 と同じ数え方
 *   `sceneShantenOfTiles`。いちばん進む打牌のあとの数）を縦軸にする。実際に切った牌が、いちばん進む打牌でなくても、値は場面の向聴数のまま
 *   （場面の向聴数のチップ「1向聴」と同じ。判断の `Decision.shanten`）。
 * - チー・ポン・大明槓は、点を作らない。鳴いたあとの打牌が、その巡目の点になる（鳴く前の手は 3n+1 枚で、切る場面ではない）。
 *   ツモも、打牌のあとでなければ点にならない。1 つの打牌に点は 1 つだけで、巡目は必ず増える（ツモかチー・ポンが、打牌の前に 1 つある）。
 *   カン（暗槓・加槓・大明槓）は、嶺上牌のツモで巡目が 1 つ増えるのに打牌は増えないので、カンのあとの打牌は、巡目が 1 つ飛ぶ（点の数は打牌の数のまま）。
 *   ツモ和了・ロンは、切らないので点にならない。
 * - 聴牌になった打牌（`tenpai`）は、向聴数が 0 でなかった点から 0 になった点（聴牌の区間ごとに最初の 1 つ。`again` は 2 つ目以降）。
 *   配牌のとき聴牌なら、最初の打牌が最初の区間の始まり（他家の `opponentTracksOf` と同じ規則）。
 * - 場面（迷いか大きな不一致。`listReplayScenes` の `ReplayScene`）は、その判断のあとに自分が最初に切る打牌の点に置く。
 *   打牌・リーチ・カンの判断は、そのまま同じ巡目の打牌（カンをしたときは、嶺上牌をツモったあとの打牌）。鳴きの判断（他家の打牌への
 *   チー・ポン・スルー）は、その次の自分の打牌。切る打牌がもう無い判断（ツモ和了・ロンの判断、局の終わりまでに切らなかった鳴き）は、最後の点に置く
 *   （切った打牌が 1 つも無い局は、配牌の点）。「AI の1位と違う判断も出す」設定の `other` は、大きな不一致ではないので置かない。
 * 本人の手だけを追うので、答える前の画面でも使える（他家の手牌は含まない）。
 */
import type { Decision } from './decision';
import type { ImportedGame } from './import';
import { KyokuReplayer } from './replay';
import type { ReplayScene } from './replay-scenes';
import type { MjaiEvent, StartKyokuEvent } from './report-types';
import { sceneShantenOfTiles } from './scene-shanten';
import type { Tile } from './tiles';

/** 折れ線の 1 点（自分が `n` 巡目に切る直前の場面）。 */
export interface MyTrackPoint {
  /** 自分の巡目（記録のまま）。0 は配牌（まだ切っていない）。 */
  n: number;
  /** mjai_log の中の位置（打牌の event。配牌は局の始まり）。 */
  eventIndex: number;
  /** 実際に切った牌（配牌は null）。 */
  discard: Tile | null;
  tsumogiri: boolean;
  /** 場面の向聴数（E-21 と同じ数え方）。0 が聴牌。 */
  shanten: number;
}

/** 聴牌になった打牌（点の `n`）。 */
export interface MyTenpaiMark {
  n: number;
  /** 聴牌を崩したあとの、2 つ目以降の聴牌の区間か。 */
  again: boolean;
}

/** 場面として置くのに必要なもの（`ReplayScene` がそのまま渡せる）。 */
export interface MyTrackSceneInput {
  /** 判断の鍵。 */
  key: string;
  decision: Pick<Decision, 'kyokuPosition' | 'eventIndex'>;
  /** この判断に結びついた迷いの番号（小さい順。迷いでなければ空）。 */
  doubts: readonly number[];
  /** 不一致の種類。大きな不一致（`big`）だけを置く。 */
  mismatch: ReplayScene['mismatch'];
}

/** 折れ線に置く場面 1 つ。 */
export interface MyTrackScene<S extends MyTrackSceneInput = MyTrackSceneInput> {
  /** 置く点の巡目（点の `n`）。 */
  n: number;
  scene: S;
  /** 迷いか。 */
  doubt: boolean;
  /** 大きな不一致か。 */
  big: boolean;
}

/** 1 局の、自分の向聴数の推移。 */
export interface MyKyokuTrack<S extends MyTrackSceneInput = MyTrackSceneInput> {
  kyokuPosition: number;
  /** 配牌（n = 0）と、切るごとの点（n の昇順）。局が無ければ空。 */
  points: MyTrackPoint[];
  /** 聴牌になった打牌（切った順）。 */
  tenpai: MyTenpaiMark[];
  /** この局の迷い・大きな不一致の場面（置く点の順。同じ点なら、判断の順）。 */
  scenes: Array<MyTrackScene<S>>;
}

/**
 * 局 `kyokuPosition` の、自分の向聴数の推移を作る。`scenes` は、半荘の場面の一覧（`listReplayScenes`。ほかの局のものが混ざっていてよい）。
 */
export function myTrackOf<S extends MyTrackSceneInput>(
  game: Pick<ImportedGame, 'report' | 'playerId' | 'kyokus'>,
  kyokuPosition: number,
  scenes: readonly S[],
): MyKyokuTrack<S> {
  const kyoku = game.kyokus[kyokuPosition];
  if (kyoku === undefined) return { kyokuPosition, points: [], tenpai: [], scenes: [] };
  const log = game.report.mjai_log;
  const me = game.playerId;
  const replayer = new KyokuReplayer(log[kyoku.startIndex] as StartKyokuEvent, me);
  const points: MyTrackPoint[] = [
    { n: 0, eventIndex: kyoku.startIndex, discard: null, tsumogiri: false, shanten: sceneShantenOfTiles(replayer.ownHand()) },
  ];
  for (let index = kyoku.startIndex + 1; index <= kyoku.endIndex; index++) {
    const event = log[index] as MjaiEvent;
    // 切る直前の手（ツモ牌・鳴いたあとの手を含む）の、場面の向聴数。event を進める前に数える
    if (event.type === 'dahai' && event.actor === me) {
      points.push({
        n: replayer.junme,
        eventIndex: index,
        discard: event.pai,
        tsumogiri: event.tsumogiri,
        shanten: sceneShantenOfTiles(replayer.ownHand()),
      });
    }
    replayer.apply(event, index);
  }

  const tenpai: MyTenpaiMark[] = [];
  let inStretch = false;
  for (const point of points.slice(1)) {
    if (point.shanten === 0 && !inStretch) tenpai.push({ n: point.n, again: tenpai.length > 0 });
    inStretch = point.shanten === 0;
  }

  const placed: Array<MyTrackScene<S>> = [];
  for (const scene of scenes) {
    if (scene.decision.kyokuPosition !== kyokuPosition) continue;
    const doubt = scene.doubts.length > 0;
    const big = scene.mismatch === 'big';
    if (!doubt && !big) continue;
    const next = points.slice(1).find((point) => point.eventIndex > scene.decision.eventIndex);
    placed.push({ n: (next ?? (points[points.length - 1] as MyTrackPoint)).n, scene, doubt, big });
  }
  placed.sort((a, b) => a.n - b.n || a.scene.decision.eventIndex - b.scene.decision.eventIndex);
  return { kyokuPosition, points, tenpai, scenes: placed };
}
