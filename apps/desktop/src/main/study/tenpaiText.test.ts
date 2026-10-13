import type { SeatTrack, TenpaiMark } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { pointNameText, routeText, shantenValueText, tenpaiLineText, tickLabelText, trackLineText, trackNow, waitsText } from './tenpaiText';

// F14・U-38（R16-7 の A）: 他家が聴牌した巡目の 1 行と、折れ線の吹き出しの文。計算はエンジン（opponent-track.test.ts）。

const mark = (over: Partial<TenpaiMark> = {}): TenpaiMark => ({
  n: 7,
  eventIndex: 40,
  discard: 'W',
  tsumogiri: false,
  route: { kind: 'call', call: 'chi', pai: '3p' },
  waits: ['5m', '8m'],
  again: false,
  ...over,
});

describe('聴牌になった打牌の 1 行', () => {
  it('承認された形: 「7巡目に聴牌（3pをチーして 打西・手出し） 待ち 5m・8m」', () => {
    expect(tenpaiLineText(mark())).toBe('7巡目に聴牌（3pをチーして 打西・手出し） 待ち 5m・8m');
  });

  it('経路: ツモ・チー・ポン・大明槓・カン（暗槓・加槓のあとの嶺上牌）。ツモ切りは「ツモ切り」', () => {
    expect(routeText({ kind: 'tsumo', drew: '4s' })).toBe('4sをツモって');
    expect(routeText({ kind: 'tsumo', drew: '5pr' })).toBe('赤5pをツモって');
    expect(routeText({ kind: 'call', call: 'pon', pai: 'F' })).toBe('發をポンして');
    expect(routeText({ kind: 'call', call: 'daiminkan', pai: '1m' })).toBe('1mを大明槓して');
    expect(routeText({ kind: 'kan', call: 'ankan', drew: '6s' })).toBe('暗槓のあと 6sをツモって');
    expect(routeText({ kind: 'kan', call: 'kakan', drew: null })).toBe('加槓のあと');
    expect(tenpaiLineText(mark({ route: { kind: 'tsumo', drew: '4s' }, discard: '6p', waits: ['4s', '7s'], n: 3 }))).toBe('3巡目に聴牌（4sをツモって 打6p・手出し） 待ち 4s・7s');
    expect(tenpaiLineText(mark({ tsumogiri: true, route: { kind: 'tsumo', drew: 'P' }, discard: 'P' }))).toBe('7巡目に聴牌（白をツモって 打白・ツモ切り） 待ち 5m・8m');
  });

  it('聴牌を崩して、また聴牌になった 2 つ目以降は「再び」。待ちが空のとき（4 枚とも自分の手にある）は「なし」', () => {
    expect(tenpaiLineText(mark({ again: true }))).toMatch(/^再び7巡目に聴牌（/);
    expect(waitsText([])).toBe('なし');
    expect(waitsText(['E', 'P'])).toBe('東・白');
  });

  it('折れ線の吹き出し: 値は「聴牌」「n向聴」、名前は「N枚目 打X（手出し）」と「配牌」。帯の目盛りは「対面が聴牌（東1局 7巡目）」', () => {
    expect(shantenValueText(0)).toBe('聴牌');
    expect(shantenValueText(2)).toBe('2向聴');
    expect(pointNameText({ n: 0, eventIndex: 0, discard: null, tsumogiri: false, shanten: 2 })).toBe('配牌');
    expect(pointNameText({ n: 7, eventIndex: 40, discard: 'W', tsumogiri: false, shanten: 0 })).toBe('7枚目 打西（手出し）');
    expect(pointNameText({ n: 3, eventIndex: 12, discard: '2s', tsumogiri: true, shanten: 1 })).toBe('3枚目 打2s（ツモ切り）');
    expect(tickLabelText('対面', '東1局', mark())).toBe('対面が聴牌（東1局 7巡目）');
  });
});

describe('いまの手までの絞り込みと、人ごとの 1 行', () => {
  const point = (n: number, eventIndex: number, shanten: number) => ({ n, eventIndex, discard: n === 0 ? null : ('1m' as const), tsumogiri: false, shanten });
  const track: SeatTrack = {
    seat: 2,
    points: [point(0, 0, 2), point(1, 10, 1), point(2, 20, 0), point(3, 30, 1), point(4, 40, 0)],
    marks: [mark({ n: 2, eventIndex: 20 }), mark({ n: 4, eventIndex: 40, again: true })],
  };

  it('手の位置以下の点・印だけ。いまの向聴数は、最後に切ったあとの数（配牌のままなら配牌の数）', () => {
    expect(trackNow(track, 0)).toMatchObject({ shanten: 2, marks: [] });
    expect(trackNow(track, 19).points.map((p) => p.n)).toEqual([0, 1]);
    expect(trackNow(track, 20).marks.map((m) => m.n)).toEqual([2]);
    expect(trackNow(track, 20).shanten).toBe(0);
    expect(trackNow(track, 99).marks.map((m) => m.n)).toEqual([2, 4]);
  });

  it('まだ聴牌になっていない → 「まだ聴牌していません（n向聴）」。聴牌 → いまの区間の最初の打牌の文。崩した → 「N巡目に聴牌していましたが、いまは…」。配牌が聴牌で、まだ切っていない → 「配牌から聴牌しています」', () => {
    expect(trackLineText(trackNow(track, 10))).toBe('まだ聴牌していません（1向聴）');
    expect(trackLineText(trackNow(track, 20))).toBe('2巡目に聴牌（3pをチーして 打西・手出し） 待ち 5m・8m');
    expect(trackLineText(trackNow(track, 30))).toBe('2巡目に聴牌していましたが、いまは聴牌していません（1向聴）');
    expect(trackLineText(trackNow(track, 40))).toBe('再び4巡目に聴牌（3pをチーして 打西・手出し） 待ち 5m・8m');
    expect(trackLineText({ points: [], marks: [], shanten: 0 })).toBe('配牌から聴牌しています');
  });
});
