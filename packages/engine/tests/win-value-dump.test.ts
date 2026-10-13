import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import { importReportText } from '../src/import';
import type { Fuuro, Wind } from '../src/report-types';
import { coreTenpaiWaits } from '../src/majiang-adapter';
import { waitPlansOf } from '../src/wait-value';
import { FIXTURES_DIR, FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// 待ちと打点の正解表（win-value-oracle.json）の入力を書き出す道具。ふだんの `pnpm test` では動かさない（環境変数 WIN_VALUE_DUMP=1 のときだけ）。
// 書き出した win-value-hands.json（実戦の聴牌になる手。手牌・副露・自風・場風・ドラ表示牌だけで、役や点数は入れない）を、
// generate_win_value.py（Python の mahjong ライブラリ）が読み、待ちと、待ちごとの役・飜・符・点数・符の内訳を独立に計算して、
// win-value-oracle.json に書く。手順（packages/engine で）:
//   WIN_VALUE_DUMP=1 pnpm exec vitest run tests/win-value-dump.test.ts
//   cd tests/fixtures && uv run --offline --with mahjong python generate_win_value.py

interface DumpedHand {
  id: string;
  game: string;
  label: string;
  closed: string[];
  melds: Fuuro[];
  /** 手の持ち主の席（副露の向きの計算に使う）。 */
  actor: number;
  /** 自風を、親からの相対席（0 = 親）。 */
  seat: number;
  round: Wind;
  dora: string[];
}

describe.skipIf(!process.env.WIN_VALUE_DUMP)('待ちと打点の正解表の入力の書き出し', () => {
  it('win-value-hands.json を作る', () => {
    const hands: DumpedHand[] = [];
    const seen = new Set<string>();
    for (const id of [...FX1_IDS, FX4_ID, FX5_ID]) {
      const game = importReportText(loadReportText(id));
      if (!game.ok) throw new Error(game.error.message);
      for (const d of game.value.decisions) {
        const me = d.board.playerId;
        for (const plan of waitPlansOf(d, null)) {
          if (coreTenpaiWaits(plan.hand, plan.melds, me).length === 0) continue;
          const hand: DumpedHand = {
            id: `${id}-k${d.kyokuPosition}-e${d.entryIndex}-${plan.key}`,
            game: id,
            label: `${d.kyokuLabel} ${d.junme}巡目`,
            closed: plan.hand,
            melds: plan.melds,
            actor: me,
            seat: (me - d.board.oya + 4) % 4,
            round: d.board.roundWind,
            dora: [...d.board.doraMarkers],
          };
          const key = JSON.stringify([hand.closed, hand.melds.map((m) => ({ ...m, target: 0 })), hand.seat, hand.round, hand.dora]);
          if (seen.has(key)) continue;
          seen.add(key);
          hands.push(hand);
        }
      }
    }
    const document = { description: '実戦の聴牌になる手（待ちと打点の正解表の入力）。waitPlansOf(判断, null) のうち聴牌のもの。', hands };
    const rows = document.hands.map((h) => `    ${JSON.stringify(h)}`).join(',\n');
    writeFileSync(path.join(FIXTURES_DIR, 'win-value-hands.json'), `{\n  "description": ${JSON.stringify(document.description)},\n  "hands": [\n${rows}\n  ]\n}\n`, 'utf-8');
  });
});
