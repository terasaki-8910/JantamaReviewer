import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import { kindToTile, toTenhouNotation } from '../src/tiles';
import { nearYaku } from '../src/yaku-near';
import { FIXTURES_DIR, loadFixtureJson } from './helpers/fixtures';
import { type OracleWin, shapeOf } from './helpers/yaku-oracle';

// 近い役の witness（最も近い和了形）を書き出す道具。ふだんの `pnpm test` では動かさない（環境変数 YAKU_WITNESS_DUMP=1 のときだけ）。
// 書き出した yaku-witness.json を、generate_yaku_witness.py（Python の mahjong ライブラリ）が採点して、役の名前（oracle）を足す。
// 手順（packages/engine で）:
//   YAKU_WITNESS_DUMP=1 pnpm exec vitest run tests/yaku-witness-dump.test.ts
//   cd tests/fixtures && uv run --offline --with mahjong python generate_yaku_witness.py

/** witness を作る手は、yaku-near.json の手のうち、この間隔のもの（yaku-near.test.ts と同じ）。 */
const WITNESS_EVERY = 2;

describe.skipIf(!process.env.YAKU_WITNESS_DUMP)('近い役の witness の書き出し', () => {
  it('yaku-witness.json を作る', () => {
    const samples = loadFixtureJson<{ samples: (Pick<OracleWin, 'closed' | 'melds' | 'seat' | 'round'> & { source: string })[] }>('yaku-near.json').samples;
    const rows: { sample: number; id: string; draws: number; target: string; win: number }[] = [];
    for (const [index, s] of samples.entries()) {
      if (index % WITNESS_EVERY !== 0) continue;
      for (const n of nearYaku(shapeOf(s), { extra: 2, maxDraws: 5 }).near) {
        const tiles: string[] = [];
        n.target.forEach((c, kind) => {
          for (let i = 0; i < c; i++) tiles.push(kindToTile(kind));
        });
        rows.push({ sample: index, id: n.id, draws: n.draws, target: toTenhouNotation(tiles), win: n.win });
      }
    }
    const document = { library: 'mahjong 2.0.0', every: WITNESS_EVERY, rows };
    writeFileSync(path.join(FIXTURES_DIR, 'yaku-witness.json'), `${JSON.stringify(document)}\n`, 'utf-8');
  });
});
