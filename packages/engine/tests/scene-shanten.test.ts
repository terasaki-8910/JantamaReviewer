import { describe, expect, it } from 'vitest';

import { shantenTag } from '../src/decision';
import { type ImportedGame, importReportText } from '../src/import';
import { sceneShanten, sceneShantenOfTiles } from '../src/scene-shanten';
import { discardOptions, shanten } from '../src/shanten';
import { parseTenhouNotation } from '../src/tiles';
import { FX1_IDS, FX4_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';

interface SceneShantenFixture {
  reports: Record<string, { decisions: number; discardType: number; scene: number[]; recorded: number[] }>;
}

const table = loadFixtureJson<SceneShantenFixture>('scene-shanten.json');

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

const IDS = [...FX1_IDS, FX4_ID] as const;

describe('E-21 場面のシャンテン数: 打牌の判断は14枚から切る牌ごとの最小、鳴きの判断は鳴く前の13枚', () => {
  it('E-21 14枚の手: 切る牌ごとのシャンテン数の最小（ツモで進めば、ツモる前より 1 小さい）', () => {
    // ツモる前は 2 シャンテン（2 面子 + 搭子 3 つ）。2p を引くと 123p ができて、9s を切れば 1 シャンテン
    expect(sceneShantenOfTiles(parseTenhouNotation('123456m1357p139s'))).toBe(2);
    expect(sceneShantenOfTiles(parseTenhouNotation('123456m12357p139s'))).toBe(1);
    // FX-3 の例（56m46688p1145888s は 14 枚で、どの打牌でも 2 シャンテン）
    expect(sceneShantenOfTiles(parseTenhouNotation('56m46688p1145888s'))).toBe(2);
  });

  it('E-21 13枚の手（鳴きの判断）: 鳴く前の手のシャンテン数そのまま', () => {
    expect(sceneShantenOfTiles(parseTenhouNotation('123456789m1155p'))).toBe(0);
    expect(sceneShantenOfTiles(parseTenhouNotation('123456789m13p57s'))).toBe(1);
    expect(sceneShantenOfTiles(parseTenhouNotation('123456m1357p139s'))).toBe(2);
  });

  it('E-21 和了形の14枚（ツモ和了の判断）は、どれを切ってもテンパイ（0）。副露のある手の 11 枚・10 枚も、枚数で決まる', () => {
    expect(sceneShantenOfTiles(parseTenhouNotation('123456789m11p123s'))).toBe(0);
    // 副露 1 つ（閉じた手が 11 枚 = 3n+2 → 切る牌ごとの最小、10 枚 = 3n+1 → そのまま）
    expect(sceneShantenOfTiles(parseTenhouNotation('123m456m789m11p'))).toBe(0);
    expect(sceneShantenOfTiles(parseTenhouNotation('123m456m789m1p'))).toBe(0);
  });

  it('E-21 FX-4 の東2局1本場 8巡目の打牌の判断（実戦は打4p）は 1 シャンテン。結果 JSON の記録は、ツモる前の 2 シャンテン', () => {
    const game = load(FX4_ID);
    const decision = game.decisions.find((d) => d.kyokuLabel === '東2局1本場' && d.junme === 8 && d.kind === 'discard');
    expect(decision).toBeDefined();
    if (!decision) return;
    expect(decision.entry.actual).toMatchObject({ type: 'dahai', pai: '4p' });
    expect(decision.entry.shanten).toBe(2);
    expect(decision.shanten).toBe(1);
    expect(decision.tags[0]).toBe('1シャンテン');
    expect(shantenTag(sceneShanten(decision.board))).toBe('1シャンテン');
  });

  for (const id of IDS) {
    it(`E-21 ${id}: 全判断で、打牌の判断の値が「切る牌ごとのシャンテン数の最小」と一致し、鳴きの判断は鳴く前の手のシャンテン数になる`, () => {
      const game = load(id);
      const python = table.reports[id];
      expect(python).toBeDefined();
      if (!python) return;
      expect(game.decisions).toHaveLength(python.decisions);
      let discardType = 0;
      for (const [index, d] of game.decisions.entries()) {
        const tiles = d.board.drawn === null ? [...d.board.hand] : [...d.board.hand, d.board.drawn];
        const where = `${id} ${d.kyokuLabel} ${d.junme}巡目 ${d.kind}`;
        if (tiles.length % 3 === 2) {
          discardType++;
          // 打牌・リーチ・自分の手番のカン・ツモ和了: 切る牌ごとのシャンテン数の最小
          expect(d.shanten, where).toBe(Math.min(...discardOptions(tiles).map((o) => o.shanten)));
          // ツモる前の手より進むことはあっても、後戻りはしない（切るのがツモ牌なら、ツモる前の手と同じ）
          expect(d.shanten, where).toBeLessThanOrEqual(d.entry.shanten);
          expect(d.shanten, where).toBeGreaterThanOrEqual(d.entry.shanten - 1);
        } else {
          // 鳴き・ロン（と、そのスルー）: 鳴く前の 13 枚
          expect(d.kind === 'call' || d.kind === 'win', where).toBe(true);
          expect(d.shanten, where).toBe(shanten(tiles));
          expect(d.shanten, where).toBe(d.entry.shanten);
        }
        // Python（独立した実装）の正解表と、全判断で一致する
        expect(d.shanten, where).toBe(python.scene[index]);
      }
      expect(discardType).toBe(python.discardType);
    });
  }
});
