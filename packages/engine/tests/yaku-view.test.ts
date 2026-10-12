import { describe, expect, it } from 'vitest';

import type { Decision } from '../src/decision';
import { type ImportedGame, importReportText } from '../src/import';
import { type QuizChoice, answerOptions, discardCandidates } from '../src/quiz-choice';
import { shantenOfCounts } from '../src/shanten';
import { TILE_KIND_COUNT, kindToTile } from '../src/tiles';
import { evaluateWin, waitsOf } from '../src/yaku';
import {
  MAX_FORCED_NEED,
  MAX_NEAR_LINES,
  NEAR_POLICY,
  SHOWN_NEAR,
  type YakuPart,
  describeYakuView,
  yakuShapeOfChoice,
  yakuTextOfChoice,
  yakuViewOf,
} from '../src/yaku-view';
import { FX1_IDS, FX4_ID, FX5_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';
import { type YakuOracleFixture, shapeOf } from './helpers/yaku-oracle';

const GAMES = [...FX1_IDS, FX4_ID, FX5_ID] as const;
const cache = new Map<string, ImportedGame>();

function load(id: string): ImportedGame {
  let game = cache.get(id);
  if (game === undefined) {
    const r = importReportText(loadReportText(id));
    if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
    game = r.value;
    cache.set(id, game);
  }
  return game;
}

function scene(id: string, kyokuLabel: string, entryIndex: number): Decision {
  const d = load(id).decisions.find((x) => x.kyokuLabel === kyokuLabel && x.entryIndex === entryIndex);
  if (d === undefined) throw new Error(`場面が見つかりません: ${id} ${kyokuLabel} e${entryIndex}`);
  return d;
}

function textOf(parts: readonly YakuPart[]): string {
  return parts.map((p) => ('text' in p ? p.text : p.tiles.join(' '))).join('');
}

/** 出題で比べる行動（打牌は、実戦と AI の上位 3 つまで。それ以外は、答えのボタンすべて）。 */
function comparedChoices(d: Decision): QuizChoice[] {
  if (d.kind === 'discard') {
    const out: QuizChoice[] = [];
    if (d.entry.actual.type === 'dahai') out.push({ type: 'dahai', tile: d.entry.actual.pai });
    for (const c of discardCandidates(d.entry).slice(0, 3)) if (!out.some((x) => x.type === 'dahai' && x.tile.replace('r', '') === c.tile.replace('r', ''))) out.push({ type: 'dahai', tile: c.tile });
    return out;
  }
  return answerOptions(d).map((o): QuizChoice => ({ type: 'option', id: o.id }));
}

describe('役の表示の見立て（出題の選択肢ごとの、確定している役・近い役・役無しの警告）', () => {
  it('行動のあとの手: 打牌は 1 枚切る、スルーは手牌のまま、ポン・チーは 2 枚を出して副露を足す、リーチは立直の旗が立つ', () => {
    // FX-4 東2局1本場 8巡目 打牌（手牌 13 + ツモ 8p。実戦は打4p）
    const discard = scene(FX4_ID, '東2局1本場', 9);
    const after = yakuShapeOfChoice(discard, { type: 'dahai', tile: '4p' });
    expect(after?.shape.counts.reduce((a, b) => a + b, 0)).toBe(13);
    expect(after?.shape.counts[12]).toBe(0); // 4p を切った
    expect(after?.shape.melds).toEqual([]);
    expect(yakuShapeOfChoice(discard, { type: 'dahai', tile: 'N' })).toBeNull(); // 手牌に無い牌

    // 同じ局の東のポン（実戦はポン）と、スルー
    const call = scene(FX4_ID, '東2局1本場', 10);
    const pon = yakuShapeOfChoice(call, { type: 'option', id: 'pon' });
    expect(pon?.shape.counts.reduce((a, b) => a + b, 0)).toBe(11);
    expect(pon?.shape.melds).toEqual([{ type: 'tri', first: 27, open: true }]);
    const pass = yakuShapeOfChoice(call, { type: 'option', id: 'pass' });
    expect(pass?.shape.counts.reduce((a, b) => a + b, 0)).toBe(13);
    expect(pass?.shape.melds).toEqual([]);
    expect(yakuShapeOfChoice(call, { type: 'option', id: 'kan' })).toBeNull();

    // チー（FX-4 東3局1本場 11巡目。6s に 5s 7s）
    const chi = yakuShapeOfChoice(scene(FX4_ID, '東3局1本場', 15), { type: 'option', id: 'chi:5s+7s' });
    expect(chi?.shape.melds).toEqual([{ type: 'seq', first: 22, open: true }]);

    // リーチ
    const riichi = load(FX1_IDS[1]).decisions.find((d) => d.kind === 'riichi');
    expect(riichi).toBeDefined();
    if (!riichi) return;
    const reach = yakuShapeOfChoice(riichi, { type: 'option', id: 'reach' });
    expect(reach?.riichi).toBe(true);
    expect(reach?.shape.counts.reduce((a, b) => a + b, 0)).toBe(14);
  });

  it('東をポンすると、役牌 東（場風）が確定する。スルーなら、東の対子と断幺九が近い役（FX-4 東2局1本場 8巡目）', () => {
    const call = scene(FX4_ID, '東2局1本場', 10);
    const pon = yakuTextOfChoice(call, { type: 'option', id: 'pon' });
    expect(pon?.view.state).toBe('open-ok');
    expect(pon?.text.settled.map((l) => l.name)).toEqual(['役牌 東（場風）']);
    expect(pon?.text.warning).toBeNull();
    expect(pon?.text.openNote).not.toBeNull();
    const pass = yakuTextOfChoice(call, { type: 'option', id: 'pass' });
    expect(pass?.view.closed).toBe(true);
    expect(pass?.text.settled).toEqual([]);
    expect(pass?.text.near.map((l) => l.name)).toEqual(['役牌 東（場風）', '断幺九']);
    expect(textOf(pass?.text.near[0]?.parts ?? [])).toBe('E Eが2枚。あと1枚（ポンかツモ）で付く');
    expect(pass?.text.closedNote).not.toBeNull();
    expect(pass?.text.openNote).toBeNull();
  });

  it('鳴いて聴牌になっても、待ちがどれも役無しなら「役無し聴牌にしかならない」と警告する（FX-4・FX-5 のチー）', () => {
    for (const [id, label, entry, choice] of [
      [FX4_ID, '東3局1本場', 15, 'chi:5s+7s'],
      [FX5_ID, '南2局', 8, 'chi:2m+3m'],
      [FX5_ID, '南4局', 2, 'chi:2s+3s'],
    ] as const) {
      const made = yakuTextOfChoice(scene(id, label, entry), { type: 'option', id: choice });
      expect(made, `${label} ${choice}`).not.toBeNull();
      expect(made?.view.state, `${label} ${choice}`).toBe('open-dead');
      expect(made?.text.warning?.level).toBe('danger');
      expect(textOf(made?.text.warning?.parts ?? [])).toContain('役無し聴牌にしかならない');
      // どの切り方も、全部の待ちが役無し
      expect(made?.view.afterDiscard.length).toBeGreaterThan(0);
      for (const a of made?.view.afterDiscard ?? []) expect(a.dead.length).toBe(a.waits.length);
    }
    // スルー（門前のまま）には、警告は無い
    const pass = yakuTextOfChoice(scene(FX5_ID, '南2局', 8), { type: 'option', id: 'pass' });
    expect(pass?.text.warning).toBeNull();
  });

  it('聴牌の手の確定している役と、一部の待ちだけで付く役（FX-5 南4局 10巡目、打1s）', () => {
    const d = scene(FX5_ID, '南4局', 11);
    const made = yakuTextOfChoice(d, { type: 'dahai', tile: '1s' });
    expect(made?.view.tenpai).toBe(true);
    expect(made?.text.settled.map((l) => l.name)).toEqual(['一盃口', '混一色']);
    expect(made?.text.partial.map((l) => l.name)).toEqual(['役牌 南（場風・自風）']);
    expect(made?.view.state).toBe('closed');
    // 打9s は、待ちが 5s の一つで、一気通貫・混一色が確定する
    const other = yakuTextOfChoice(d, { type: 'dahai', tile: '9s' });
    expect(other?.text.settled.map((l) => l.name)).toEqual(['一気通貫', '混一色']);
  });

  it('門前でダマだと役が無い待ちがあるときは、薄い注にする（FX-1 f7388969 東3局2本場 7巡目 のスルー）', () => {
    const d = scene(FX1_IDS[1], '東3局2本場', 7);
    const made = yakuTextOfChoice(d, { type: 'option', id: 'pass' });
    expect(made?.view.closed).toBe(true);
    expect(made?.view.dama).toBe('dead');
    expect(made?.text.warning?.level).toBe('info');
    expect(textOf(made?.text.warning?.parts ?? [])).toContain('ロンできない');
  });

  it('全ての判断（7 半荘）の全ての比べる行動で、見立てが組み立てられ、決まりを守っている', () => {
    let choices = 0;
    let elapsed = 0;
    for (const id of GAMES) {
      for (const d of load(id).decisions) {
        if (d.kind === 'win') continue;
        for (const choice of comparedChoices(d)) {
          const made = yakuShapeOfChoice(d, choice);
          if (made === null) continue;
          const t0 = performance.now();
          const view = yakuViewOf(made.shape, { riichi: made.riichi });
          elapsed += performance.now() - t0;
          const text = describeYakuView(view, made.shape);
          const where = `${id} ${d.kyokuLabel} ${d.junme}巡目 ${JSON.stringify(choice)}`;
          choices++;
          // 最短の和了の距離は、向聴数 + 1
          expect(view.rMin, where).toBe(shantenOfCounts(made.shape.counts) + 1);
          // 近い役: 引く枚数 3 枚以内、遠回り 1 枚以内、表示する役だけ、確定・一部の待ちと重ならない
          const known = new Set([...view.settled.settled.map((h) => h.id), ...view.settled.partial.map((p) => p.id)]);
          for (const n of view.near) {
            expect(n.draws, where).toBeLessThanOrEqual(NEAR_POLICY.maxDraws);
            expect(n.extra, where).toBeLessThanOrEqual(NEAR_POLICY.extra);
            expect(SHOWN_NEAR, where).toContain(n.id);
            expect(known.has(n.id), where).toBe(false);
          }
          expect(text.near.length, where).toBeLessThanOrEqual(MAX_NEAR_LINES);
          for (const n of view.near) {
            if (n.id === 'sanshoku' || n.id === 'ittsu') {
              const line = text.near.find((l) => l.id === n.id);
              if (line !== undefined) expect(line.parts.flatMap((p) => ('tiles' in p ? p.tiles : [])).length, where).toBeLessThanOrEqual(MAX_FORCED_NEED);
            }
          }
          // 確定している役は、聴牌なら全ての待ち（役満の待ちを除く）に付いている
          for (const h of view.settled.settled) {
            if (view.settled.waits.length > 0 && h.id !== 'riichi') for (const w of view.settled.waits) expect(w.hits.some((x) => x.id === h.id), `${where} ${h.id}`).toBe(true);
          }
          // 門前と副露で、一言が変わる
          expect(text.closedNote !== null, where).toBe(view.closed);
          // 副露した手で役が無く、近い役も無ければ、警告が出る
          if (!view.closed && view.settled.settled.length === 0 && view.near.length === 0 && !view.tenpai && view.afterDiscard.length === 0) {
            expect(view.state, where).toBe('open-lost');
            expect(text.warning?.level, where).toBe('danger');
          }
          // 聴牌になる切り方は、切ると聴牌（向聴数 0）になるものだけ
          for (const a of view.afterDiscard) {
            const counts = [...made.shape.counts];
            counts[a.kind] = (counts[a.kind] as number) - 1;
            expect(shantenOfCounts(counts), where).toBe(0);
          }
        }
      }
    }
    expect(choices).toBeGreaterThan(3000);
    // 1 回の見立ては、平均 1 ミリ秒前後（計測は 0.3 ミリ秒）。余裕を見て、全部で 10 秒以内
    expect(elapsed).toBeLessThan(10_000);
  });

  it('実戦の和了 69 件: 和了牌の直前の手（聴牌）の、その待ちの役が、和了の役の数え方（ロン）と一致する', () => {
    const oracle = loadFixtureJson<YakuOracleFixture>('yaku-oracle.json');
    for (const w of oracle.wins) {
      const shape = shapeOf(w);
      const counts = [...shape.counts];
      counts[w.win] = (counts[w.win] as number) - 1;
      const before = { ...shape, counts };
      const waits = waitsOf(before, w.riichi);
      const wait = waits.find((x) => x.kind === w.win);
      const where = `${w.game} ${w.kyoku} ${w.closed} 和了牌 ${kindToTile(w.win)}`;
      expect(wait, where).toBeDefined();
      if (wait === undefined) continue;
      const ron = evaluateWin({ ...shape, winKind: w.win, tsumo: false, riichi: w.riichi });
      expect(wait.hits.map((h) => h.id).sort(), where).toEqual(ron.hits.map((h) => h.id).sort());
      // 和了牌のほかの待ちは、すべて牌の種類として有効
      for (const x of waits) expect(x.kind).toBeLessThan(TILE_KIND_COUNT);
    }
  });
});
