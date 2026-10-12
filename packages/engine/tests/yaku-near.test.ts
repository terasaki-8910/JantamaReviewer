import { describe, expect, it } from 'vitest';

import { shantenOfCounts } from '../src/shanten';
import { toTenhouNotation, kindToTile } from '../src/tiles';
import { SHAPE_YAKU, type YakuId } from '../src/yaku';
import { type NearYaku, nearYaku } from '../src/yaku-near';
import { loadFixtureJson } from './helpers/fixtures';
import { type OracleWin, oracleIds, shapeOf } from './helpers/yaku-oracle';

interface NearSample extends Pick<OracleWin, 'closed' | 'melds' | 'seat' | 'round'> {
  game: string;
  kyoku: number;
  entry: number;
  source: string;
  /** 最短の和了（役を問わない）の r。rmax を超えるときは null。 */
  min_r: number | null;
  /** 役の名前 → その役が付く和了形の最小の r（rmax まで）。 */
  by_yaku: Record<string, number>;
  /** 力ずくで数えた r の上限（無ければ fixture の rmax）。 */
  rmax_used?: number;
}

interface NearFixture {
  library: string;
  rmax: number;
  samples: NearSample[];
}

/** 近い役の witness（最も近い和了形）を採点する正解表（generate_yaku_witness.py）。 */
interface WitnessRow {
  sample: number;
  id: YakuId;
  draws: number;
  /** 和了形（閉じた手牌。天鳳の牌理の表記）。 */
  target: string;
  win: number;
  /** ライブラリが数えた役の名前。 */
  oracle?: string[];
}

interface WitnessFixture {
  library: string;
  every: number;
  rows: Required<WitnessRow>[];
}

/** witness を作る手は、正解表の手のうち、この間隔のもの（generate_yaku_witness.py と同じ）。 */
const WITNESS_EVERY = 2;

const fixture = loadFixtureJson<NearFixture>('yaku-near.json');

function toTenhou(counts: readonly number[]): string {
  const tiles: string[] = [];
  counts.forEach((c, kind) => {
    for (let i = 0; i < c; i++) tiles.push(kindToTile(kind));
  });
  return toTenhouNotation(tiles);
}

function oracleDistances(sample: NearSample): Map<YakuId, number> {
  const out = new Map<YakuId, number>();
  for (const [name, r] of Object.entries(sample.by_yaku)) {
    const [id] = oracleIds([name]);
    if (id !== undefined) out.set(id, r);
  }
  return out;
}

describe('近い役: 力ずくで数えた正解（Python の mahjong ライブラリ。探し方の違う実装）と一致する', () => {
  it('正解表の作りが期待どおり（ライブラリのバージョン、件数、実戦と乱数の手、役が一通り出てくる）', () => {
    expect(fixture.library).toBe('mahjong 2.0.0');
    expect(fixture.samples.length).toBeGreaterThanOrEqual(300);
    const sources = new Set(fixture.samples.map((s) => s.source.split(' ')[0]));
    for (const s of ['real-discard', 'real-pass', 'real-chi', 'real-pon', 'synthetic-13', 'synthetic-14']) expect(sources.has(s), s).toBe(true);
    const seen = new Set<YakuId>();
    for (const s of fixture.samples) for (const id of oracleDistances(s).keys()) seen.add(id);
    for (const id of SHAPE_YAKU) expect(seen.has(id), `${id} が正解表に出てくる`).toBe(true);
  });

  it('全ての手で、最短の和了の距離と、役ごとの距離（r 3 まで。2 向聴の手は 4 まで）が力ずくの値と全部一致する', () => {
    let compared = 0;
    let yakuChecked = 0;
    for (const s of fixture.samples) {
      const shape = shapeOf(s);
      const rmax = s.rmax_used ?? fixture.rmax;
      const where = `${s.source} ${s.closed} ${JSON.stringify(s.melds)}`;
      const result = nearYaku(shape, { extra: 99, maxDraws: rmax });
      // 最短の和了: 向聴数から決まる値と同じ（力ずくで見つからなければ rmax より遠い）
      expect(shantenOfCounts(shape.counts) + 1 <= rmax ? shantenOfCounts(shape.counts) + 1 : null, where).toBe(s.min_r);
      const theirs = oracleDistances(s);
      const mine = new Map<YakuId, number>(result.near.map((n: NearYaku) => [n.id, n.draws]));
      for (const id of SHAPE_YAKU) {
        expect(mine.get(id) ?? null, `${where} ${id}`).toBe(theirs.get(id) ?? null);
        if (mine.has(id)) yakuChecked++;
      }
      compared++;
    }
    expect(compared).toBe(fixture.samples.length);
    expect(yakuChecked).toBeGreaterThan(1000);
  });

  it('近い役ごとの最も近い和了形（witness）を、ライブラリが採点して、その役が付く（健全性。力ずくで数えられない遠さ r 5 までを含む）', () => {
    const witnesses = loadFixtureJson<WitnessFixture>('yaku-witness.json');
    expect(witnesses.library).toBe('mahjong 2.0.0');
    // いまの実装が作る witness が、正解表を作ったときと同じ（違えば、generate_yaku_witness.py で作り直す）
    const current: WitnessRow[] = [];
    for (const [index, s] of fixture.samples.entries()) {
      if (index % WITNESS_EVERY !== 0) continue;
      const result = nearYaku(shapeOf(s), { extra: 2, maxDraws: 5 });
      for (const n of result.near) {
        current.push({ sample: index, id: n.id, draws: n.draws, target: toTenhou(n.target), win: n.win });
      }
    }
    expect(current).toEqual(witnesses.rows.map(({ sample, id, draws, target, win }) => ({ sample, id, draws, target, win })));
    let checked = 0;
    let farther = 0;
    for (const row of witnesses.rows) {
      expect(oracleIds(row.oracle), `${row.sample} ${row.id} ${row.target} 和了牌 ${row.win}`).toContain(row.id);
      checked++;
      if (row.draws >= 5) farther++;
    }
    expect(checked).toBeGreaterThan(500);
    expect(farther).toBeGreaterThan(0);
  });
});
