import { describe, expect, it } from 'vitest';

import { importReportText } from '../src/import';
import { shanten } from '../src/shanten';
import { FX1_IDS, loadReportText } from './helpers/fixtures';

// 受け入れ基準（E-3）の正解表（FX-3）とは別に、実戦の手牌でもシャンテン数の実装を確かめる。
// 記録の shanten（Mortal が判断のときに持っていたシャンテン数）は、ツモ牌を除いた閉じた手牌のシャンテン数。
// 副露のある手（閉じた牌が 10・11・7・8・5 枚）も含めて、964判断すべてで一致する。
describe('E-3 FX-1 の実戦の手牌のシャンテン数', () => {
  for (const id of FX1_IDS) {
    it(`E-3 ${id}: ツモ牌を除いた閉じた手牌のシャンテン数が、全判断で記録の shanten と一致する`, () => {
      const result = importReportText(loadReportText(id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const mismatches = result.value.decisions
        .filter((d) => shanten(d.board.hand) !== d.entry.shanten)
        .map((d) => `${d.kyokuLabel} ${d.junme}巡目: 実装 ${shanten(d.board.hand)} / 記録 ${d.entry.shanten}（${d.board.hand.join(' ')}）`);
      expect(mismatches).toEqual([]);
    });
  }

  it('E-3 副露のある手牌（閉じた牌が少ない）の判断が、FX-1 に含まれる', () => {
    let melded = 0;
    for (const id of FX1_IDS) {
      const result = importReportText(loadReportText(id));
      if (!result.ok) throw new Error(result.error.message);
      melded += result.value.decisions.filter((d) => d.board.hand.length < 13 && d.board.hand.length % 3 !== 0).length;
    }
    expect(melded).toBeGreaterThan(100);
  });
});
