/**
 * 半荘を通して見る画面の文言・局の選択の数・行き先（replayModel.ts）の試験。FX-4（実際の半荘）の時間軸で確かめる。
 */
import { DEFAULT_CONTEST_OPTIONS, buildReplayTimeline, listReplayScenes, type KyokuEnd, type Seat } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import {
  TABLE_CHROME_PX,
  compactBelowHeight,
  deltaItems,
  formatSigned,
  kyokuCounts,
  kyokuShortLabel,
  mismatchName,
  replayNav,
  replayStops,
  resultText,
  sceneSubText,
  sceneTags,
  seatName,
  stepText,
  turnLabel,
} from './replayModel';

const game = gameOf('fx4');
const timeline = buildReplayTimeline(game);
const me = timeline.playerId;

/** ユーザーが選んだ迷いの結びつけ（迷い 1〜6 の順）。 */
const MARK_KEYS = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];
const scenes = listReplayScenes(timeline, game.decisions, { markKeys: MARK_KEYS, threshold: 0.05, includeAll: false });
const stopOf = (key: string): number => {
  const scene = scenes.find((item) => item.key === key);
  if (scene === undefined) throw new Error(key);
  return scene.step;
};

const END_BASE: KyokuEnd = { kind: 'draw', delta: 0, deltas: [0, 0, 0, 0], winners: [], ronFrom: null };

describe('文言', () => {
  it('巡目の言い方: 0 は配牌', () => {
    expect(turnLabel(0)).toBe('配牌');
    expect(turnLabel(1)).toBe('1巡目');
    expect(turnLabel(17)).toBe('17巡目');
  });

  it('局の名前の短い書き方（位置の帯の、狭いときの区間の名前）', () => {
    expect(kyokuShortLabel('東1局')).toBe('東1');
    expect(kyokuShortLabel('東2局1本場')).toBe('東2-1');
    expect(kyokuShortLabel('南4局12本場')).toBe('南4-12');
    expect(kyokuShortLabel('わからない')).toBe('わからない');
  });

  it('点の増減は、符号をそろえる（正は +、負は U+2212 のマイナス、0 は ±0）', () => {
    expect(formatSigned(1300)).toBe('+1,300');
    expect(formatSigned(-1300)).toBe('−1,300');
    expect(formatSigned(0)).toBe('±0');
    expect(formatSigned(-12000)).toBe('−12,000');
  });

  it('席の呼び名は、本人から見た位置（自分・下家・対面・上家）', () => {
    expect([0, 1, 2, 3].map((seat) => seatName(0, seat as Seat))).toEqual(['自分', '下家', '対面', '上家']);
    expect([0, 1, 2, 3].map((seat) => seatName(2, seat as Seat))).toEqual(['対面', '上家', '自分', '下家']);
  });

  it('「いまの一手」の文は、全 289 手で、種類ごとの形になる（空の文は無い）', () => {
    const who = '(自分|下家|対面|上家)';
    const forms: Record<string, RegExp> = {
      start_kyoku: new RegExp(`^[東南西北][1-4]局([0-9]+本場)?が始まりました（親は${who}）$`),
      tsumo: /^自分が .+ をツモりました$/,
      dahai: new RegExp(`^${who}が .+ を切りました(（ツモ切り）)?$`),
      reach: new RegExp(`^${who}がリーチを宣言しました$`),
      chi: new RegExp(`^${who}が ${who}の .+ をチーしました$`),
      pon: new RegExp(`^${who}が ${who}の .+ をポンしました$`),
      daiminkan: new RegExp(`^${who}が ${who}の .+ を大明槓しました$`),
      kakan: new RegExp(`^${who}が .+ を加槓しました$`),
      ankan: new RegExp(`^${who}が .+ を暗槓しました$`),
      hora: /^この局が終わりました$/,
      ryukyoku: /^流局しました$/,
    };
    const seen = new Set<string>();
    for (const step of timeline.steps) {
      const kyokuLabel = timeline.kyokus[step.kyokuPosition]!.label;
      const text = stepText(step, me, kyokuLabel);
      const type = step.event.type;
      const form = forms[type];
      expect(form, `想定していない event: ${type}`).toBeDefined();
      expect(text, `${kyokuLabel} 手${step.position + 1} ${type}`).toMatch(form!);
      seen.add(type);
    }
    // FX-4 には、ポン（迷い 4）とリーチと和了が含まれる
    for (const type of ['start_kyoku', 'tsumo', 'dahai', 'pon', 'reach', 'hora']) expect(seen.has(type), type).toBe(true);
  });

  it('局の最初の手は「東1局が始まりました（親は自分）」。ツモ切りには「（ツモ切り）」が付く', () => {
    expect(stepText(timeline.steps[0]!, me, '東1局')).toBe('東1局が始まりました（親は自分）');
    const tsumogiri = timeline.steps.find((step) => step.event.type === 'dahai' && step.event.tsumogiri);
    expect(tsumogiri).toBeDefined();
    expect(stepText(tsumogiri!, me, '東1局')).toMatch(/（ツモ切り）$/);
    const handCut = timeline.steps.find((step) => step.event.type === 'dahai' && !step.event.tsumogiri);
    expect(stepText(handCut!, me, '東1局')).not.toMatch(/ツモ切り/);
  });

  it('局の結果の 1 行（自分の和了・放銃・他家のツモ和了・他家のロン・流局）', () => {
    expect(resultText(END_BASE, 0)).toBe('流局');
    expect(resultText({ ...END_BASE, kind: 'win', winners: [0], ronFrom: null }, 0)).toBe('自分の和了（ツモ）');
    expect(resultText({ ...END_BASE, kind: 'win', winners: [0], ronFrom: 2 }, 0)).toBe('自分の和了（対面から）');
    expect(resultText({ ...END_BASE, kind: 'dealIn', winners: [3], ronFrom: 0 }, 0)).toBe('放銃: 上家のロン');
    expect(resultText({ ...END_BASE, kind: 'othersTsumo', winners: [1], ronFrom: null }, 0)).toBe('下家のツモ和了');
    expect(resultText({ ...END_BASE, kind: 'othersRon', winners: [1], ronFrom: 3 }, 0)).toBe('下家のロン（上家から）');
    expect(resultText({ ...END_BASE, kind: 'othersRon', winners: [1, 2], ronFrom: 3 }, 0)).toBe('下家・対面のロン（上家から）');
    // 本人が別の席のとき（席ではなく、本人からの位置で呼ぶ）
    expect(resultText({ ...END_BASE, kind: 'win', winners: [2], ronFrom: 0 }, 2)).toBe('自分の和了（対面から）');
    expect(resultText({ ...END_BASE, kind: 'othersTsumo', winners: [0], ronFrom: null }, 2)).toBe('対面のツモ和了');
  });

  it('FX-4 の各局の結果は、牌譜の結果と同じ（東2局1本場は、自分の和了（対面から）+1,300）', () => {
    const labels = timeline.kyokus.map((kyoku) => (kyoku.end === null ? '' : resultText(kyoku.end, me)));
    expect(labels).toHaveLength(5);
    expect(labels[2]).toBe('自分の和了（対面から）');
    expect(deltaItems(timeline.kyokus[2]!.end!, me).map((item) => item.text)).toEqual(['自分 +1,300', '下家 ±0', '対面 −1,300', '上家 ±0']);
    for (const kyoku of timeline.kyokus) {
      expect(kyoku.end).not.toBeNull();
      expect(kyoku.end!.deltas).toHaveLength(4);
      expect(kyoku.end!.deltas[me]).toBe(kyoku.end!.delta);
    }
  });

  it('点の増減は、自分から、下家・対面・上家の順。自分の行に印', () => {
    const end: KyokuEnd = { ...END_BASE, kind: 'othersRon', winners: [3], ronFrom: 1, deltas: [-1000, 8000, 0, -7000] };
    expect(deltaItems(end, 1)).toEqual([
      { name: '自分', text: '自分 +8,000', mine: true },
      { name: '下家', text: '下家 ±0', mine: false },
      { name: '対面', text: '対面 −7,000', mine: false },
      { name: '上家', text: '上家 −1,000', mine: false },
    ]);
  });

  it('不一致の名前: 基準未満は「大きな不一致」、AI の1位と違うだけは「不一致」', () => {
    expect(mismatchName('big')).toBe('大きな不一致');
    expect(mismatchName('other')).toBe('不一致');
  });

  it('場面の札: 迷いの番号（複数は「・」でつなぐ）と不一致の名前', () => {
    expect(sceneTags({ doubts: [], mismatch: null })).toEqual([]);
    expect(sceneTags({ doubts: [3], mismatch: null })).toEqual([{ kind: 'doubt', text: '迷い3' }]);
    expect(sceneTags({ doubts: [1, 2], mismatch: null })).toEqual([{ kind: 'doubt', text: '迷い1・2' }]);
    expect(sceneTags({ doubts: [2], mismatch: 'big' })).toEqual([
      { kind: 'doubt', text: '迷い2' },
      { kind: 'mis', text: '大きな不一致' },
    ]);
    expect(sceneTags({ doubts: [], mismatch: 'other' })).toEqual([{ kind: 'mis', text: '不一致' }]);
  });

  it('場面の一覧の 2 行目: 種類と向聴数（0 以下は聴牌）', () => {
    expect(sceneSubText({ kind: 'discard', shanten: 2 }, '打牌')).toBe('打牌 · 2向聴');
    expect(sceneSubText({ kind: 'call', shanten: 0 }, '鳴き')).toBe('鳴き · 聴牌');
  });
});

describe('局の選択の数', () => {
  it('局ごとの迷いと不一致（迷い 2 は不一致でもあるので、両方に数える）', () => {
    const counts = timeline.kyokus.map((kyoku) => kyokuCounts(timeline, scenes, kyoku.position));
    // 迷い 2 は細かいミスでもある（実戦が AI の1位と違う）。拮抗は、この設定（出さない）では数えない
    expect(counts).toEqual(['迷い1', '迷い1 · 細かいミス1 · 不一致1', '迷い2 · 不一致2', '', '迷い2 · 不一致2']);
  });

  it('場面が無いときは、どの局も空', () => {
    expect(timeline.kyokus.map((kyoku) => kyokuCounts(timeline, [], kyoku.position))).toEqual(['', '', '', '', '']);
  });
});

describe('卓の大きさの切り替えの高さ', () => {
  it('河の段の数と、リーチ宣言牌の有無と、他家の手牌の帯（対面の上の 1 段。R16-7）で決まる（式は quiz.css の --kwy・--cwy と同じ）', () => {
    expect(compactBelowHeight(2, false)).toBe(966);
    expect(compactBelowHeight(2, true)).toBe(978);
    expect(compactBelowHeight(3, false)).toBe(1064);
    expect(compactBelowHeight(3, true)).toBe(1076);
    expect(compactBelowHeight(4, false)).toBe(1162);
    expect(compactBelowHeight(4, true)).toBe(1174);
  });

  it('操作の段が折り返して増えた高さ（barExtra）の分だけ、高い窓が要る。足さなければ、変わらない（F17）', () => {
    expect(compactBelowHeight(3, false, 0)).toBe(compactBelowHeight(3, false));
    expect(compactBelowHeight(3, false, 36)).toBe(compactBelowHeight(3, false) + 36);
    expect(compactBelowHeight(2, true, 72)).toBe(compactBelowHeight(2, true) + 72);
  });

  it('段が増えるほど高く、卓の外の高さより必ず高い', () => {
    for (const riichi of [false, true]) {
      let previous = compactBelowHeight(2, riichi);
      expect(previous).toBeGreaterThan(TABLE_CHROME_PX);
      for (const rows of [3, 4, 5]) {
        const height = compactBelowHeight(rows, riichi);
        expect(height).toBeGreaterThan(previous);
        previous = height;
      }
    }
  });
});

describe('行き先', () => {
  const stops = replayStops(timeline, scenes);

  it('迷い・不一致・自分の判断の手の通し番号（昇順）', () => {
    expect(stops.doubts).toEqual(MARK_KEYS.map(stopOf));
    expect(stops.mismatches).toEqual(['k1h0e12', 'k1h1e6', 'k1h1e9', 'k2h1e2', 'k2h1e16'].map(stopOf));
    for (const list of [stops.doubts, stops.mismatches, stops.decisions]) {
      expect([...list].sort((a, b) => a - b)).toEqual(list);
    }
    expect(stops.decisions.length).toBeGreaterThan(stops.doubts.length);
  });

  it('最初の手: 戻る先は無く、進む先と局の終わりと次の局がある。迷い 6・不一致 5 が先にある', () => {
    const nav = replayNav(timeline, stops, 0);
    expect(nav.step_back).toBeNull();
    expect(nav.step_forward).toBe(1);
    expect(nav.prev_decision).toBeNull();
    expect(nav.prev_doubt).toBeNull();
    expect(nav.prev_mismatch).toBeNull();
    expect(nav.prev_kyoku).toBeNull();
    expect(nav.prev_turn).toBeNull();
    expect(nav.kyoku_start).toBeNull();
    expect(nav.kyoku_end).toBe(timeline.kyokus[0]!.last);
    expect(nav.next_kyoku).toBe(timeline.kyokus[1]!.first);
    expect(nav.next_doubt).toBe(stops.doubts[0]);
    expect(nav.next_mismatch).toBe(stops.mismatches[0]);
    expect(nav.doubtsAhead).toBe(6);
    expect(nav.mismatchesAhead).toBe(5);
  });

  it('最後の手: 進む先・次の局・局の終わり・先の迷いは無い', () => {
    const last = timeline.steps.length - 1;
    const nav = replayNav(timeline, stops, last);
    expect(nav.step_forward).toBeNull();
    expect(nav.step_back).toBe(last - 1);
    expect(nav.next_kyoku).toBeNull();
    expect(nav.next_turn).toBeNull();
    expect(nav.kyoku_end).toBeNull();
    expect(nav.next_doubt).toBeNull();
    expect(nav.next_mismatch).toBeNull();
    expect(nav.doubtsAhead).toBe(0);
    expect(nav.mismatchesAhead).toBe(0);
    expect(nav.kyoku_start).toBe(timeline.kyokus[4]!.first);
  });

  it('場面の上（迷い 2。大きな不一致でもある）: 前後の迷い・不一致は、自分より前・後だけ。先の数は自分を含まない', () => {
    const g = stopOf('k1h0e12');
    const nav = replayNav(timeline, stops, g);
    expect(nav.prev_doubt).toBe(stopOf('k0h0e4'));
    expect(nav.next_doubt).toBe(stopOf('k1h1e7'));
    expect(nav.prev_mismatch).toBeNull();
    expect(nav.next_mismatch).toBe(stopOf('k1h1e6'));
    expect(nav.doubtsAhead).toBe(4);
    expect(nav.mismatchesAhead).toBe(4);
  });

  it('全 289 手で、行き先は、いまの手より前・後の正しい側にあり、同じ局の中や隣の局に収まる', () => {
    expect(timeline.steps).toHaveLength(289);
    for (const step of timeline.steps) {
      const g = step.index;
      const nav = replayNav(timeline, stops, g);
      const kyoku = timeline.kyokus[step.kyokuPosition]!;
      const before = [nav.step_back, nav.prev_decision, nav.prev_doubt, nav.prev_mismatch, nav.prev_turn];
      const after = [nav.step_forward, nav.next_decision, nav.next_doubt, nav.next_mismatch, nav.next_turn];
      for (const target of before) if (target !== null) expect(target, `手 ${g}`).toBeLessThan(g);
      for (const target of after) if (target !== null) expect(target, `手 ${g}`).toBeGreaterThan(g);
      expect(nav.step_back).toBe(g === 0 ? null : g - 1);
      expect(nav.step_forward).toBe(g === timeline.steps.length - 1 ? null : g + 1);
      if (nav.kyoku_start !== null) expect(nav.kyoku_start).toBe(kyoku.first);
      if (nav.kyoku_end !== null) expect(nav.kyoku_end).toBe(kyoku.last);
      expect(nav.kyoku_start === null).toBe(g === kyoku.first);
      expect(nav.kyoku_end === null).toBe(g === kyoku.last);
      if (nav.next_kyoku !== null) expect(timeline.steps[nav.next_kyoku]!.kyokuPosition).toBe(step.kyokuPosition + 1);
      if (nav.prev_kyoku !== null) expect(timeline.steps[nav.prev_kyoku]!.kyokuPosition).toBe(step.kyokuPosition - 1);
      expect(nav.doubtsAhead).toBe(stops.doubts.filter((target) => target > g).length);
      expect(nav.mismatchesAhead).toBe(stops.mismatches.filter((target) => target > g).length);
    }
  });
});

describe('F16・F17 解決した場面・細かいミス・拮抗（場面の札・局の選択の数・行き先）', () => {
  /** 差 100 ポイント・1 巡目以降: 2 つ以上の候補がある判断は、すべて拮抗の場面になる（数を増やして確かめるため）。 */
  const wide = { ...DEFAULT_CONTEST_OPTIONS, maxGap: 1, minJunme: 1 };
  const withContest = listReplayScenes(timeline, game.decisions, { markKeys: MARK_KEYS, threshold: 0.05, includeAll: false, contest: wide });
  const resolvedKeys = (...keys: string[]) => new Set(keys);
  const scenesWith = (resolved: ReadonlySet<string>, contest = wide) =>
    listReplayScenes(timeline, game.decisions, { markKeys: MARK_KEYS, threshold: 0.05, includeAll: false, contest, resolvedKeys: resolved });

  it('場面の札: 細かいミスは迷いの札と同じ形、拮抗は不一致の札と同じ形。迷い → 細かいミス → 不一致 → 拮抗の順', () => {
    expect(sceneTags({ doubts: [2], mismatch: 'big', fineMiss: true, contest: { gap: 0.1 } })).toEqual([
      { kind: 'doubt', text: '迷い2' },
      { kind: 'doubt', text: '細かいミス' },
      { kind: 'mis', text: '大きな不一致' },
      { kind: 'mis', text: '拮抗' },
    ]);
    expect(sceneTags({ doubts: [], mismatch: null, fineMiss: false, contest: { gap: 0 } })).toEqual([{ kind: 'mis', text: '拮抗' }]);
    expect(sceneTags({ doubts: [3], mismatch: null, fineMiss: false, contest: null })).toEqual([{ kind: 'doubt', text: '迷い3' }]);
  });

  it('場面: 細かいミスは迷い 2 だけ。拮抗の設定が無いと、拮抗の場面は無い。解決していない', () => {
    expect(scenes.filter((scene) => scene.fineMiss).map((scene) => scene.key)).toEqual(['k1h0e12']);
    expect(scenes.every((scene) => scene.contest === null && !scene.resolved)).toBe(true);
    expect(withContest.filter((scene) => scene.contest !== null).length).toBeGreaterThan(20);
  });

  it('局の選択の数: 拮抗の数が入る。解決した場面は、数から除いて「解決 N」に回す', () => {
    const counts = timeline.kyokus.map((kyoku) => kyokuCounts(timeline, withContest, kyoku.position));
    expect(counts.every((text) => text.includes('拮抗'))).toBe(true);
    const resolved = scenesWith(resolvedKeys('k1h0e12', 'k1h1e6'));
    const after = timeline.kyokus.map((kyoku) => kyokuCounts(timeline, resolved, kyoku.position));
    // 東2局（位置 1）: 迷い 2 を解決 → 迷い 0・細かいミス 0。不一致 1（迷い 2 は不一致でもあった）も除かれ、解決 1
    expect(after[1]).not.toContain('迷い');
    expect(after[1]).not.toContain('細かいミス');
    expect(after[1]).toContain('解決1');
    // 東2局1本場（位置 2）: 大きな不一致 k1h1e6 を解決
    expect(after[2]).toContain('解決1');
    expect(after[0]).not.toContain('解決');
  });

  it('止まる場所: 解決した場面は、迷い・不一致・拮抗のどれにも入れない。場面の一覧（scenes）には残る', () => {
    const resolved = scenesWith(resolvedKeys('k1h0e12', 'k1h1e7', 'k2h1e16'));
    expect(resolved.filter((scene) => scene.resolved).map((scene) => scene.key)).toEqual(['k1h0e12', 'k1h1e7', 'k2h1e16']);
    const stops = replayStops(timeline, resolved);
    expect(stops.doubts).toEqual(['k0h0e4', 'k1h1e10', 'k2h1e6', 'k2h1e14'].map(stopOf));
    expect(stops.mismatches).toEqual(['k1h1e6', 'k1h1e9', 'k2h1e2'].map(stopOf));
    const contestStops = replayStops(timeline, withContest).contests;
    expect(stops.contests).toHaveLength(contestStops.length - resolved.filter((scene) => scene.resolved && scene.contest !== null).length);
    for (const scene of resolved.filter((item) => item.resolved)) {
      expect(stops.doubts).not.toContain(scene.step);
      expect(stops.mismatches).not.toContain(scene.step);
      expect(stops.contests).not.toContain(scene.step);
    }
  });

  it('「細かいミスだけ」: 迷いの止まる場所が、細かいミスだけになる。不一致・拮抗は変わらない', () => {
    const all = replayStops(timeline, withContest);
    const only = replayStops(timeline, withContest, { fineMissOnly: true });
    expect(all.doubts).toHaveLength(6);
    expect(only.doubts).toEqual([stopOf('k1h0e12')]);
    expect(only.mismatches).toEqual(all.mismatches);
    expect(only.contests).toEqual(all.contests);
    // 解決した細かいミスは、「細かいミスだけ」でも止まらない
    const resolved = scenesWith(resolvedKeys('k1h0e12'));
    expect(replayStops(timeline, resolved, { fineMissOnly: true }).doubts).toEqual([]);
  });

  it('行き先と数: 前・次の拮抗と、半荘全体の数・先の数は、解決した場面を数えない。いまが解決した場面の上でも、前後の止まる場所へ動ける', () => {
    const resolved = scenesWith(resolvedKeys('k1h0e12'));
    const stops = replayStops(timeline, resolved, {});
    const g = stopOf('k1h0e12');
    const nav = replayNav(timeline, stops, g);
    // 迷い 2 を解決した: 迷いは 5 か所。いまの場面は止まる場所ではないので、前は迷い 1、次は迷い 3
    expect(nav.doubtTotal).toBe(5);
    expect(nav.prev_doubt).toBe(stopOf('k0h0e4'));
    expect(nav.next_doubt).toBe(stopOf('k1h1e7'));
    expect(nav.doubtsAhead).toBe(4);
    // 不一致は、迷い 2 でもある k1h0e12 を除いた 4 か所
    expect(nav.mismatchTotal).toBe(4);
    expect(nav.mismatchesAhead).toBe(4);
    expect(nav.prev_mismatch).toBeNull();
    // 拮抗
    expect(nav.contestTotal).toBe(stops.contests.length);
    expect(nav.next_contest).toBe(stops.contests.find((step) => step > g) ?? null);
    expect(nav.prev_contest).toBe([...stops.contests].reverse().find((step) => step < g) ?? null);
    expect(nav.contestsAhead).toBe(stops.contests.filter((step) => step > g).length);
    // 先頭では、前は無く、次は先頭の拮抗
    const first = replayNav(timeline, stops, 0);
    expect(first.prev_contest).toBeNull();
    expect(first.next_contest).toBe(stops.contests[0]);
    // 全部の手で、次の拮抗は後ろ・前の拮抗は前
    for (const step of timeline.steps) {
      const at = replayNav(timeline, stops, step.index);
      if (at.next_contest !== null) expect(at.next_contest).toBeGreaterThan(step.index);
      if (at.prev_contest !== null) expect(at.prev_contest).toBeLessThan(step.index);
    }
  });
});
