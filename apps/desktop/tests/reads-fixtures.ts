/**
 * 読み（F23）の試験に使う固定データ。
 *
 * FX-4 の本物の読み（`reads-fx4.json`。解析エンジンと tenpai.onnx で作った 55 場面。作り方は generate_reads_fx4.sh）と、
 * 読みのモデルを使わずに作る見本（場面の位置だけが本物の牌譜と合っていて、数は決まった値）。
 * 試験のデータで、画面の部品ではない（Node 側で動く試験からだけ読む）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ImportedGame } from '@jantama/engine';

import type { OpponentReads, Reads, ReadsMoment } from '../src/api/reads';

const FIXTURES = resolve(import.meta.dirname, '../../../packages/engine/tests/fixtures');

/** FX-4 の読み（本物の出力）。 */
export function fx4Reads(): Reads {
  return JSON.parse(readFileSync(resolve(FIXTURES, 'reads-fx4.json'), 'utf8')) as Reads;
}

export const EMPTY_WAITS = (): number[] => new Array<number>(34).fill(0);

/** 他家 1 人の見本（数は決まった値。`riichi` なら、読み直した扱いで `reasons` を持つ）。 */
export function opponent(step: 1 | 2 | 3, seat: number, patch: Partial<OpponentReads> = {}): OpponentReads {
  return {
    seat,
    step,
    riichi: false,
    tenpai: 0.1,
    furiten: 0,
    waits: EMPTY_WAITS(),
    top_waits: [],
    actual_waits: [],
    reasons: {},
    ...patch,
  };
}

/** 場面 1 つの見本。 */
export function moment(kyokuIndex: number, eventIndex: number, patch: Partial<ReadsMoment> = {}): ReadsMoment {
  return {
    event_index: eventIndex,
    kyoku_index: kyokuIndex,
    bakaze: 'E',
    kyoku: 1,
    honba: 0,
    junme: 1,
    hand: [],
    any_wait: EMPTY_WAITS(),
    opponents: [opponent(1, 1), opponent(2, 2), opponent(3, 3)],
    ...patch,
  };
}

/**
 * 牌譜の、自分のツモ・チー・ポンの event ごとに 1 場面を持つ読み（数は 0 のまま）。
 * 自分のリーチのあとの打牌が、どの場面の読みを使うかを、本物の牌譜の位置で確かめるのに使う。
 */
export function syntheticReads(game: ImportedGame): Reads {
  const moments: ReadsMoment[] = [];
  let kyoku = -1;
  game.report.mjai_log.forEach((event, index) => {
    if (event.type === 'start_kyoku') kyoku += 1;
    const mine = 'actor' in event && event.actor === game.playerId;
    if (mine && (event.type === 'tsumo' || event.type === 'chi' || event.type === 'pon')) moments.push(moment(kyoku, index));
  });
  return { format: 'jantama-reads/1', model: { file: 'tenpai.onnx', sha256: '0'.repeat(64) }, player_id: game.playerId, moments };
}
