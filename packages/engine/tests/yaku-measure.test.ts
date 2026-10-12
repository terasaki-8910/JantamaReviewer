import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import type { Decision } from '../src/decision';
import { type ImportedGame, importReportText } from '../src/import';
import { type QuizChoice, answerOptions, discardCandidates } from '../src/quiz-choice';
import { YAKU_NAMES, type YakuId, SHAPE_YAKU } from '../src/yaku';
import { type YakuViewOptions, describeYakuView, yakuShapeOfChoice, yakuViewOf } from '../src/yaku-view';
import { nearYaku } from '../src/yaku-near';
import { FX1_IDS, FX4_ID, FX5_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';
import { type YakuOracleFixture, oracleIds } from './helpers/yaku-oracle';

// 役の表示の調査の計測。ふだんの `pnpm test` では動かさない（環境変数 YAKU_MEASURE=出力先のフォルダ のときだけ）。
//   YAKU_MEASURE=<フォルダ> pnpm exec vitest run tests/yaku-measure.test.ts
// 出力: <フォルダ>/measure.json。README（analysis/yaku/README.md）の数字は、この計測の出力。

const GAMES = [...FX1_IDS, FX4_ID, FX5_ID] as const;

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

/** 出題で比べる行動（自分の答え・実戦・AI の 1 位。自分の答えは分からないので、AI の 2 位で代える）の組。 */
function comparedChoices(decision: Decision): QuizChoice[] {
  const out: QuizChoice[] = [];
  const add = (c: QuizChoice | null) => {
    if (c === null) return;
    const key = c.type === 'dahai' ? `d:${c.tile.replace('r', '')}` : `o:${c.id}`;
    if (!out.some((x) => (x.type === 'dahai' ? `d:${x.tile.replace('r', '')}` : `o:${x.id}`) === key)) out.push(c);
  };
  if (decision.kind === 'discard') {
    const actual = decision.entry.actual;
    const cands = discardCandidates(decision.entry);
    if (actual.type === 'dahai') add({ type: 'dahai', tile: actual.pai });
    for (const c of cands.slice(0, 3)) add({ type: 'dahai', tile: c.tile });
    return out.slice(0, 3);
  }
  for (const o of answerOptions(decision)) add({ type: 'option', id: o.id });
  return out.slice(0, 4);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

describe.skipIf(!process.env.YAKU_MEASURE)('役の表示の計測', () => {
  it('実戦の和了の役・場面の費用・近い役の出方を数える', () => {
    const outDir = process.env.YAKU_MEASURE as string;
    mkdirSync(outDir, { recursive: true });
    const result: Record<string, unknown> = {};

    // 1) 実戦の和了 69 件（7 半荘）の役の数
    const oracle = loadFixtureJson<YakuOracleFixture>('yaku-oracle.json');
    const winCounts = new Map<string, number>();
    const winHan: number[] = [];
    let open = 0;
    let riichiWins = 0;
    let me = 0;
    for (const w of oracle.wins) {
      for (const id of new Set(oracleIds(w.oracle.yaku))) winCounts.set(id, (winCounts.get(id) ?? 0) + 1);
      winHan.push(w.oracle.han);
      if (w.melds.some(([, , isOpen]) => isOpen)) open++;
      if (w.riichi) riichiWins++;
      if (w.me) me++;
    }
    result.wins = {
      total: oracle.wins.length,
      mine: me,
      open,
      riichi: riichiWins,
      byYaku: Object.fromEntries([...winCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => [id, n])),
      noYakuOtherThanDora: oracle.wins.filter((w) => w.oracle.yaku.length === 0).length,
    };

    // 2) 場面
    interface Row {
      game: string;
      decision: string;
      kind: string;
      choice: string;
      closed: boolean;
      total: number;
      ms: number;
      leaves: number;
      rMin: number;
      state: string;
      dama: string | null;
      settled: YakuId[];
      near: { id: YakuId; draws: number; extra: number }[];
    }
    const rows: Row[] = [];
    const wideTimes: number[] = [];
    const wideLeaves: number[] = [];
    const variants: { name: string; options: YakuViewOptions }[] = [
      { name: 'extra1-max4', options: { extra: 1, maxDraws: 4 } },
      { name: 'extra0-max4', options: { extra: 0, maxDraws: 4 } },
      { name: 'extra1-max3', options: { extra: 1, maxDraws: 3 } },
      { name: 'extra2-max4', options: { extra: 2, maxDraws: 4 } },
    ];
    const variantNear = new Map<string, Map<string, number[]>>(); // variant -> id -> [per choice counts]
    const variantCountHist = new Map<string, number[]>(); // variant -> histogram of shown near count
    for (const v of variants) {
      variantNear.set(v.name, new Map());
      variantCountHist.set(v.name, [0, 0, 0, 0, 0]);
    }
    // 表示の決まり（NEAR_POLICY・MAX_NEAR_LINES・役牌は 1 枚以上持つとき）で出る行の数
    const shownHist = { closed: [0, 0, 0, 0], open: [0, 0, 0, 0] };
    const shownUncappedHist = { closed: [0, 0, 0, 0, 0], open: [0, 0, 0, 0, 0] };
    const shownById = new Map<string, number>();
    let emptyDisplay = 0;
    let sceneDiffers = 0;
    let sceneMulti = 0;
    let scenes = 0;
    const sceneMs: number[] = [];
    for (const id of GAMES) {
      const game = load(id);
      for (const d of game.decisions) {
        const choices = comparedChoices(d);
        if (choices.length === 0 || d.kind === 'win') continue;
        let sceneTotal = 0;
        let any = false;
        const sceneSets: string[] = [];
        for (const choice of choices) {
          const made = yakuShapeOfChoice(d, choice);
          if (made === null) continue;
          any = true;
          const t0 = performance.now();
          const view = yakuViewOf(made.shape, { riichi: made.riichi });
          const ms = performance.now() - t0;
          sceneTotal += ms;
          const policy = nearYaku(made.shape, { extra: 1, maxDraws: 3 });
          const w0 = performance.now();
          const wide = nearYaku(made.shape, { extra: 1, maxDraws: 4 });
          const wideMs = performance.now() - w0;
          wideTimes.push(wideMs);
          wideLeaves.push(wide.leaves);
          const total = made.shape.counts.reduce((a, b) => a + b, 0);
          rows.push({
            game: id,
            decision: `${d.kyokuLabel} ${d.junme}巡目 e${d.entryIndex}`,
            kind: d.kind,
            choice: choice.type === 'dahai' ? `打${choice.tile}` : choice.id,
            closed: view.closed,
            total,
            ms,
            leaves: policy.leaves,
            rMin: view.rMin,
            state: view.state,
            dama: view.dama,
            settled: view.settled.settled.map((h) => h.id),
            near: view.near.map((n) => ({ id: n.id, draws: n.draws, extra: n.extra })),
          });
          const text = describeYakuView(view, made.shape);
          const bucket = view.closed ? 'closed' : 'open';
          shownHist[bucket][Math.min(3, text.near.length)] = (shownHist[bucket][Math.min(3, text.near.length)] as number) + 1;
          shownUncappedHist[bucket][Math.min(4, view.near.length)] = (shownUncappedHist[bucket][Math.min(4, view.near.length)] as number) + 1;
          for (const n of view.near) shownById.set(n.id, (shownById.get(n.id) ?? 0) + 1);
          if (text.settled.length === 0 && text.near.length === 0 && text.warning === null) emptyDisplay++;
          sceneSets.push([...view.settled.settled.map((h) => h.id), '|', ...view.near.map((n) => n.id)].join(','));
          for (const v of variants) {
            const list = nearYaku(made.shape, { ...v.options, ids: SHAPE_YAKU }).near;
            const shown = list.filter((n) => !['pinfu', 'iipeikou', 'ryanpeikou', 'sankantsu', 'honroto'].includes(n.id));
            const hist = variantCountHist.get(v.name) as number[];
            hist[Math.min(4, shown.length)] = (hist[Math.min(4, shown.length)] as number) + 1;
            const byId = variantNear.get(v.name) as Map<string, number[]>;
            for (const n of list) byId.set(n.id, [...(byId.get(n.id) ?? []), n.draws]);
          }
        }
        if (any) {
          scenes++;
          sceneMs.push(sceneTotal);
          if (sceneSets.length >= 2) {
            sceneMulti++;
            if (new Set(sceneSets).size > 1) sceneDiffers++;
          }
        }
      }
    }
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    sceneMs.sort((a, b) => a - b);
    const leaves = rows.map((r) => r.leaves).sort((a, b) => a - b);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    result.cost = {
      scenes,
      choices: rows.length,
      perChoiceMs: { mean: sum(ms) / ms.length, median: percentile(ms, 0.5), p95: percentile(ms, 0.95), p99: percentile(ms, 0.99), max: ms[ms.length - 1] },
      perSceneMs: { mean: sum(sceneMs) / sceneMs.length, median: percentile(sceneMs, 0.5), p95: percentile(sceneMs, 0.95), max: sceneMs[sceneMs.length - 1] },
      leaves: { mean: sum(leaves) / leaves.length, median: percentile(leaves, 0.5), p95: percentile(leaves, 0.95), max: leaves[leaves.length - 1] },
    };
    wideTimes.sort((a, b) => a - b);
    wideLeaves.sort((a, b) => a - b);
    result.costWide = {
      note: '引く枚数の上限を 4 にした探索（遠回り 1 枚まで）',
      perChoiceMs: { mean: sum(wideTimes) / wideTimes.length, median: percentile(wideTimes, 0.5), p95: percentile(wideTimes, 0.95), p99: percentile(wideTimes, 0.99), max: wideTimes[wideTimes.length - 1] },
      leaves: { mean: sum(wideLeaves) / wideLeaves.length, median: percentile(wideLeaves, 0.5), p95: percentile(wideLeaves, 0.95), max: wideLeaves[wideLeaves.length - 1] },
    };
    const kinds = new Map<string, number>();
    for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    const states = new Map<string, number>();
    for (const r of rows) states.set(r.closed ? `closed${r.dama ? `-dama-${r.dama}` : ''}` : r.state, (states.get(r.closed ? `closed${r.dama ? `-dama-${r.dama}` : ''}` : r.state) ?? 0) + 1);
    const settledById = new Map<string, number>();
    for (const r of rows) for (const idd of new Set(r.settled)) settledById.set(idd, (settledById.get(idd) ?? 0) + 1);
    const byRMin = new Map<number, number>();
    for (const r of rows) byRMin.set(r.rMin, (byRMin.get(r.rMin) ?? 0) + 1);
    result.choices = {
      byKind: Object.fromEntries(kinds),
      closed: rows.filter((r) => r.closed).length,
      open: rows.filter((r) => !r.closed).length,
      states: Object.fromEntries([...states.entries()].sort()),
      settledById: Object.fromEntries([...settledById.entries()].sort((a, b) => b[1] - a[1])),
      withSettled: rows.filter((r) => r.settled.length > 0).length,
      rMinHistogram: Object.fromEntries([...byRMin.entries()].sort((a, b) => a[0] - b[0])),
    };
    const variantReport: Record<string, unknown> = {};
    for (const v of variants) {
      const byId = variantNear.get(v.name) as Map<string, number[]>;
      variantReport[v.name] = {
        shownNearCountHistogram: variantCountHist.get(v.name),
        choicesWithNearById: Object.fromEntries([...byId.entries()].sort((a, b) => b[1].length - a[1].length).map(([idd, xs]) => [idd, xs.length])),
      };
    }
    result.variants = variantReport;
    result.policy = {
      shownLinesHistogramCapped: shownHist,
      shownLinesHistogramUncapped: shownUncappedHist,
      shownById: Object.fromEntries([...shownById.entries()].sort((a, b) => b[1] - a[1])),
      choicesWithEmptyDisplay: emptyDisplay,
      multiChoiceScenes: sceneMulti,
      scenesWhereChoicesDiffer: sceneDiffers,
    };
    result.rows = rows;
    writeFileSync(path.join(outDir, 'measure.json'), JSON.stringify(result, null, 1), 'utf-8');
    // 要約
    const summary = { wins: result.wins, cost: result.cost, costWide: result.costWide, choices: result.choices, policy: result.policy, variants: Object.fromEntries(variants.map((v) => [v.name, (variantReport[v.name] as { shownNearCountHistogram: number[] }).shownNearCountHistogram])) };
    console.log(JSON.stringify(summary, null, 1));
    void YAKU_NAMES;
  }, 600000);
});
