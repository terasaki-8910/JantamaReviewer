/**
 * 他家が聴牌した巡目（F14、E-43・U-38。R16-7 の A）の言い方。計算はエンジン（`opponentTracksOf`）、ここは文にするだけ。
 *
 * 1 行: 「7巡目に聴牌（3pをチーして 打西・手出し） 待ち 5m・8m」。まだ聴牌していないときは「まだ聴牌していません（2向聴）」。
 * 「N巡目」は、その人が N 枚目の牌を切ったとき（河の左から数えた枚数）。
 * そのほか、折れ線の吹き出しの文（値が先、名前があと）と、位置の帯の目盛りの文。
 */
import { tileLabel, type KyokuTracks, type SeatTrack, type TenpaiMark, type TenpaiRoute, type TrackPoint } from '@jantama/engine';

const CALL_NAME = { chi: 'チー', pon: 'ポン', daiminkan: '大明槓' } as const;
const KAN_NAME = { ankan: '暗槓', kakan: '加槓', daiminkan: '大明槓' } as const;

/** 聴牌になった打牌の直前に、その人がしたこと。例: 3pをチーして・4sをツモって・暗槓のあと 6sをツモって。 */
export function routeText(route: TenpaiRoute): string {
  switch (route.kind) {
    case 'tsumo':
      return `${tileLabel(route.drew)}をツモって`;
    case 'call':
      return `${tileLabel(route.pai)}を${CALL_NAME[route.call]}して`;
    case 'kan':
      return `${KAN_NAME[route.call]}のあと${route.drew === null ? '' : ` ${tileLabel(route.drew)}をツモって`}`;
  }
}

/** 待ち。例: 5m・8m（待ちが無い聴牌は「なし」）。 */
export function waitsText(waits: readonly string[]): string {
  return waits.length === 0 ? 'なし' : waits.map(tileLabel).join('・');
}

/** 聴牌になった打牌 1 つの 1 行。例: 7巡目に聴牌（3pをチーして 打西・手出し） 待ち 5m・8m。聴牌を崩したあとの 2 回目以降は「再び」を頭に付ける。 */
export function tenpaiLineText(mark: TenpaiMark): string {
  const how = `${routeText(mark.route)} 打${tileLabel(mark.discard)}・${mark.tsumogiri ? 'ツモ切り' : '手出し'}`;
  return `${mark.again ? '再び' : ''}${mark.n}巡目に聴牌（${how}） 待ち ${waitsText(mark.waits)}`;
}

/** 手の位置 `eventIndex` までの、その人の点・印・いまの向聴数。 */
export interface TrackNow {
  points: TrackPoint[];
  marks: TenpaiMark[];
  /** いまの（最後に切ったあとの）向聴数。配牌のまま（まだ切っていない）なら配牌の向聴数。 */
  shanten: number;
}

/** 手の位置 `eventIndex`（その event を進めたあと）までに絞る。 */
export function trackNow(track: SeatTrack, eventIndex: number): TrackNow {
  const points = track.points.filter((point) => point.eventIndex <= eventIndex);
  const marks = track.marks.filter((mark) => mark.eventIndex <= eventIndex);
  const last = points[points.length - 1];
  return { points, marks, shanten: last === undefined ? 0 : last.shanten };
}

/**
 * 1 行。いまの手が聴牌なら、いまの区間の最初の打牌（最後の印）の文。まだ聴牌になっていなければ「まだ聴牌していません（n向聴）」。
 * 聴牌を崩したあとなら、「N巡目に聴牌していましたが、いまは聴牌していません（n向聴）」。配牌が聴牌で、まだ切っていなければ「配牌から聴牌しています」。
 */
export function trackLineText(now: TrackNow): string {
  const mark = now.marks[now.marks.length - 1];
  if (now.shanten === 0) return mark === undefined ? '配牌から聴牌しています' : tenpaiLineText(mark);
  if (mark === undefined) return `まだ聴牌していません（${now.shanten}向聴）`;
  return `${mark.n}巡目に聴牌していましたが、いまは聴牌していません（${now.shanten}向聴）`;
}

/** 向聴数の言い方（折れ線の吹き出しの値）。0 は聴牌。 */
export function shantenValueText(shanten: number): string {
  return shanten === 0 ? '聴牌' : `${shanten}向聴`;
}

/** 折れ線の吹き出しの名前。例: 7枚目 打西（手出し）・配牌。 */
export function pointNameText(point: TrackPoint): string {
  if (point.discard === null) return '配牌';
  return `${point.n}枚目 打${tileLabel(point.discard)}（${point.tsumogiri ? 'ツモ切り' : '手出し'}）`;
}

/** 位置の帯の目盛りの文。例: 対面が聴牌（東1局 7巡目）。 */
export function tickLabelText(who: string, kyokuLabel: string, mark: TenpaiMark): string {
  return `${who}が聴牌（${kyokuLabel} ${mark.n}巡目）`;
}

/** 手 `eventIndex` の盤面で、聴牌になった打牌の枠を付ける河の位置（席 → 河の添字の集合。0 から）。 */
export function tenpaiRiverMarks(tracks: KyokuTracks, eventIndex: number): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const track of tracks.seats) {
    out.set(
      track.seat,
      new Set(track.marks.filter((mark) => mark.eventIndex <= eventIndex).map((mark) => mark.n - 1)),
    );
  }
  return out;
}
