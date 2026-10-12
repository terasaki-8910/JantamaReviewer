import { describe, expect, it } from 'vitest';

import { compareDiscardUkeire } from '../src/discard-compare';
import { type ImportedGame, framesBeforeDecision, importReportText } from '../src/import';
import { listDisagreements } from '../src/disagreement';
import { discardOptions, ukeire } from '../src/shanten';
import { tenhouPairiUrl } from '../src/tenhou-url';
import { countTiles, tileKind } from '../src/tiles';
import { FX1_IDS, loadReportText } from './helpers/fixtures';

const games = new Map<string, ImportedGame>();
for (const id of FX1_IDS) {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  games.set(id, r.value);
}

function gameOf(id: string): ImportedGame {
  const g = games.get(id);
  if (!g) throw new Error(id);
  return g;
}

describe('F6 打牌の受け入れ枚数の比較（E-3 の計算を判断につなぐ）', () => {
  it('F6 打牌の判断では、実戦の打牌・AI の1位・最大の受け入れ枚数が出る。実戦の牌は全件で手牌の中にある', () => {
    let checked = 0;
    for (const id of FX1_IDS) {
      for (const d of gameOf(id).decisions) {
        const cmp = compareDiscardUkeire(d);
        const tiles = d.board.drawn === null ? [...d.board.hand] : [...d.board.hand, d.board.drawn];
        if (tiles.length % 3 !== 2) {
          expect(cmp, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBeNull();
          continue;
        }
        expect(cmp).not.toBeNull();
        if (!cmp) continue;
        checked++;
        if (d.entry.actual.type === 'dahai') {
          expect(cmp.actual, `${id} ${d.kyokuLabel} ${d.junme}巡目 実戦の打牌`).toBeDefined();
          expect(cmp.actual?.kind).toBe(tileKind(d.entry.actual.pai));
        } else {
          expect(cmp.actual).toBeUndefined();
        }
        const top = d.entry.details[0]?.action;
        if (top?.type === 'dahai') expect(cmp.top?.kind).toBe(tileKind(top.pai));
        expect(cmp.best.length).toBeGreaterThan(0);
        expect(cmp.pairiUrl).toBe(tenhouPairiUrl(tiles));
      }
    }
    expect(checked).toBeGreaterThan(700);
  });

  it('F6 最大の受け入れ枚数は、切った後の向聴数が最小の候補の中の最大。どの候補より多いか少ないかを比べられる', () => {
    const d = gameOf('f9da87cbcd7af5e9').decisions[0];
    expect(d).toBeDefined();
    if (!d) return;
    const cmp = compareDiscardUkeire(d, '5m');
    expect(cmp).not.toBeNull();
    if (!cmp) return;
    const minShanten = Math.min(...cmp.options.map((o) => o.shanten));
    const maxUkeire = Math.max(...cmp.options.filter((o) => o.shanten === minShanten).map((o) => o.ukeire));
    for (const b of cmp.best) {
      expect(b.shanten).toBe(minShanten);
      expect(b.ukeire).toBe(maxUkeire);
    }
    // 自分の答え（5m）の結果は、options の中の同じ牌の結果と同じ
    expect(cmp.answer).toBe(cmp.options.find((o) => o.tile === '5m'));
    // 赤五を答えにしても、同じ種類として見つかる
    const red = compareDiscardUkeire(d, '5sr');
    expect(red?.answer?.tile).toBe('5s');
  });

  it('F6 自分の答えが手牌に無い牌なら answer は無い。答えを渡さなければ answer も無い', () => {
    const d = gameOf('f9da87cbcd7af5e9').decisions[0];
    if (!d) throw new Error('判断がありません');
    expect(compareDiscardUkeire(d, 'C')?.answer).toBeUndefined();
    expect(compareDiscardUkeire(d)?.answer).toBeUndefined();
  });

  it('F6 結果は、手牌（ツモ牌を含む）に discardOptions をそのまま使ったものと同じ', () => {
    const d = gameOf('f9da87cbcd7af5e9').decisions[0];
    if (!d) throw new Error('判断がありません');
    const tiles = [...d.board.hand, ...(d.board.drawn === null ? [] : [d.board.drawn])];
    expect(compareDiscardUkeire(d)?.options).toEqual(discardOptions(tiles));
    // 3n+1 枚（他家の打牌への鳴きの判断）は受け入れ枚数の比較ではなく、手牌そのものの受け入れ
    const call = gameOf('f9da87cbcd7af5e9').decisions.find((x) => x.kind === 'call');
    if (!call) throw new Error('鳴きの判断がありません');
    expect(compareDiscardUkeire(call)).toBeNull();
    expect(ukeire(call.board.hand).shanten).toBe(call.entry.shanten);
    expect(countTiles(call.board.hand).reduce((a, b) => a + b, 0) % 3).toBe(1);
  });
});

describe('F3 判断の2〜3巡前から再生できる', () => {
  const game = gameOf('f9da87cbcd7af5e9');
  const worst = listDisagreements(game.decisions).items[0]?.decision;

  it('F3 東4局13巡目の判断を、2巡前（11巡目）から判断の時点まで、event ごとに返す', () => {
    expect(worst?.junme).toBe(13);
    if (!worst) return;
    const frames = framesBeforeDecision(game, worst, 2);
    expect(frames.length).toBeGreaterThan(5);
    expect(frames[0]?.board.junme).toBe(11);
    expect(frames[frames.length - 1]?.eventIndex).toBe(worst.eventIndex);
    expect(frames[frames.length - 1]?.board).toEqual(worst.board);
    const indices = frames.map((f) => f.eventIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(indices).size).toBe(indices.length);
    // 最初の盤面は、本人のそのツモの直後（手牌がツモ牌を含む）
    expect(frames[0]?.board.drawn).not.toBeNull();
  });

  it('F3 3巡前なら10巡目から始まり、2巡前より長い', () => {
    if (!worst) throw new Error('判断がありません');
    const two = framesBeforeDecision(game, worst, 2);
    const three = framesBeforeDecision(game, worst, 3);
    expect(three[0]?.board.junme).toBe(10);
    expect(three.length).toBeGreaterThan(two.length);
    expect(three.slice(three.length - two.length).map((f) => f.eventIndex)).toEqual(two.map((f) => f.eventIndex));
  });

  it('F3 巡目が少なくて遡れないときは、配牌（局の最初）から始まる。0 巡前なら判断のツモの直後から', () => {
    const early = game.decisions.find((d) => d.junme === 2 && d.kyokuPosition === 0);
    if (!early) throw new Error('2巡目の判断がありません');
    const frames = framesBeforeDecision(game, early, 3);
    expect(frames[0]?.board.junme).toBe(0);
    expect(frames[0]?.board.tilesLeft).toBe(70);
    expect(frames[frames.length - 1]?.board).toEqual(early.board);
    const now = framesBeforeDecision(game, early, 0);
    expect(now[0]?.board.junme).toBe(early.board.junme);
    expect(now[now.length - 1]?.board).toEqual(early.board);
  });
});
