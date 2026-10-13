import { describe, expect, it } from 'vitest';

import { importReportText } from '../src/import';
import type { ImportedGame } from '../src/import';
import { kyokuResultOf, type KyokuWinView } from '../src/kyoku-result';
import { coreTenpaiWaits } from '../src/majiang-adapter';
import { meldTiles } from '../src/ukeire-remaining';
import { sortTiles, tileKind } from '../src/tiles';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// E-40 局の結果の手（F14。U-36 の局の結果の手の部分の土台）: 固定データの 7 半荘の和了 69 件で、和了者・手牌・役・点数が牌譜と一致し、
// 放銃した局の相手の手牌と待ちが出る。流局は 4 人の手牌（荒牌平局は聴牌・ノーテン）。
//
// 「牌譜」の正解は、結果 JSON の split_logs（tenhou.net/6 形式の局ごとの牌譜）の最後の要素 ["和了", 点の増減, [和了者, 放銃者, 責任払い, 点数の文, 役...]]。
// 役の名前・飜（ドラ・赤ドラ・裏ドラを含む）・符・飜・点数の文（満貫・跳満・「3000-6000点」「700点∀」など）が書いてある。これと、牌譜（mjai_log）から
// 組み立てて majiang-core で計算し直した値（kyoku-result.ts）を、全部照らす。ドラ類の飜は、手牌・ドラ表示牌・裏ドラ表示牌の牌 1 枚まで合わないと一致しないので、
// 和了者の手牌の組み立て（閉じた手牌・副露・和了牌）の確かめも兼ねる。さらに、手牌は聴牌の形で、待ちに和了牌が入っていること（`waits`）も確かめる。

const IDS = [...FX1_IDS, FX4_ID, FX5_ID];

function load(id: string): ImportedGame {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value;
}

interface LoggedWin {
  winner: number;
  target: number;
  text: string;
  yaku: Array<{ name: string; han: number }>;
}

/** split_logs（tenhou.net/6 形式）の、局の最後の要素から、和了を取り出す（ダブロンは、点の増減と詳細の組が続く）。 */
function loggedWins(game: ImportedGame, position: number): LoggedWin[] {
  const split = game.report.split_logs[position] as { log: unknown[][] };
  const last = (split.log[0] as unknown[]).at(-1) as unknown[];
  if (last[0] !== '和了') return [];
  const out: LoggedWin[] = [];
  for (let i = 1; i < last.length; i += 2) {
    const info = last[i + 1] as [number, number, number, string, ...string[]];
    out.push({
      winner: info[0],
      target: info[1],
      text: info[3],
      yaku: info.slice(4).map((entry) => {
        const m = /^(.+)\((\d+)飜\)$/.exec(entry as string);
        if (m === null) throw new Error(`知らない役の書き方: ${String(entry)}`);
        return { name: m[1] as string, han: Number(m[2]) };
      }),
    });
  }
  return out;
}

/** 点数の文: 「30符1飜1000点」「満貫8000点」「跳満3000-6000点」「30符2飜700点∀」。 */
function parseLoggedPoints(text: string) {
  const limit = /^(満貫|跳満|倍満|三倍満|役満|数え役満)/.exec(text)?.[1] ?? null;
  const fuHan = /^(\d+)符(\d+)飜/.exec(text);
  const pay = /(\d+)(?:-(\d+))?点(∀)?$/.exec(text);
  if (pay === null) throw new Error(`知らない点数の書き方: ${text}`);
  return {
    limit,
    fu: fuHan === null ? null : Number(fuHan[1]),
    han: fuHan === null ? null : Number(fuHan[2]),
    first: Number(pay[1]),
    second: pay[2] === undefined ? null : Number(pay[2]),
    all: pay[3] !== undefined,
  };
}

/** エンジンの役（画面に出す名前）を、牌譜（tenhou 形式）の役の名前にする。場風・自風は、牌に関係なく別の役の名前。 */
function loggedYakuOf(yaku: ReadonlyArray<{ name: string; han: number }>): Array<{ name: string; han: number }> {
  return yaku.flatMap((y) => {
    const m = /^役牌 (.)（(場風・自風|場風|自風)）$/.exec(y.name);
    if (m === null) return [y];
    const out: Array<{ name: string; han: number }> = [];
    if (m[2] !== '自風') out.push({ name: '役牌:場風牌', han: 1 });
    if (m[2] !== '場風') out.push({ name: '役牌:自風牌', han: 1 });
    return out;
  });
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** 全半荘の、局ごとの結果の手（和了の局は和了、流局は流局）。 */
function allResults() {
  const out: Array<{ id: string; game: ImportedGame; position: number; result: ReturnType<typeof kyokuResultOf> }> = [];
  for (const id of IDS) {
    const game = load(id);
    for (let position = 0; position < game.kyokus.length; position++) {
      out.push({ id, game, position, result: kyokuResultOf(game.report, position) });
    }
  }
  return out;
}

describe('E-40 局の結果の手: 固定データの和了 69 件が、牌譜（split_logs の和了）と一致する', () => {
  const results = allResults();
  const wins: Array<{ name: string; game: ImportedGame; position: number; index: number; view: KyokuWinView; logged: LoggedWin }> = [];
  for (const { id, game, position, result } of results) {
    if (result === null || result.kind !== 'win') continue;
    const logged = loggedWins(game, position);
    result.wins.forEach((view, index) => {
      wins.push({ name: `${id} 局${position}（${game.kyokus[position]?.label}）和了${index}`, game, position, index, view, logged: logged[index] as LoggedWin });
    });
  }

  it('和了は 69 件。すべての局に結果の手が出て、和了の数は牌譜（end_status・split_logs）と同じ', () => {
    expect(wins).toHaveLength(69);
    for (const { id, game, position, result } of results) {
      expect(result, `${id} 局${position}`).not.toBeNull();
      const ended = (game.report.review.kyokus[position]?.end_status ?? []).filter((e) => e.type === 'hora');
      const view = result?.kind === 'win' ? result.wins.length : 0;
      expect(view, `${id} 局${position}`).toBe(ended.length);
      expect(loggedWins(game, position), `${id} 局${position}`).toHaveLength(ended.length);
    }
  });

  it('和了者・放銃者・ツモかロンかが、牌譜と一致する', () => {
    for (const { name, view, logged } of wins) {
      expect(view.winner, name).toBe(logged.winner);
      expect(view.target, name).toBe(logged.target);
      expect(view.tsumo, name).toBe(logged.winner === logged.target);
      expect(view.deltas.length, name).toBe(4);
    }
  });

  it('役の名前と飜（ドラ・赤ドラ・裏ドラを含む）が、牌譜と一致する', () => {
    const seen = new Set<string>();
    for (const { name, view, logged } of wins) {
      const loggedYaku = logged.yaku.filter((y) => !/ドラ$/.test(y.name));
      const loggedDora = (label: string) => logged.yaku.filter((y) => y.name === label).reduce((sum, y) => sum + y.han, 0);
      expect(loggedYakuOf(view.yaku).sort(byName), name).toEqual(loggedYaku.sort(byName));
      expect(view.dora.dora, name).toBe(loggedDora('ドラ'));
      expect(view.dora.aka, name).toBe(loggedDora('赤ドラ'));
      expect(view.dora.ura, name).toBe(loggedDora('裏ドラ'));
      for (const y of loggedYaku) seen.add(y.name);
    }
    // 69 件が、役の種類も、立直・ツモ・副露・ドラ類も、まんべんなく含む（偏っていると、確かめにならない）
    expect(seen.size).toBeGreaterThanOrEqual(15);
    expect(wins.filter((w) => w.view.dora.ura > 0).length).toBeGreaterThan(3);
    expect(wins.filter((w) => w.view.dora.aka > 0).length).toBeGreaterThan(3);
    expect(wins.filter((w) => w.view.melds.length > 0).length).toBeGreaterThan(3);
  });

  it('符・飜・点数（満貫などの名前、ツモの支払いを含む）が、牌譜と一致する', () => {
    const limits = new Set<string>();
    for (const { name, view, logged } of wins) {
      const p = parseLoggedPoints(logged.text);
      expect(view.line.none, name).toBe(false);
      expect(view.line.limit, name).toBe(p.limit);
      if (p.limit === null) {
        expect(view.line.fu, name).toBe(p.fu);
        expect(view.line.han, name).toBe(p.han);
      } else {
        limits.add(p.limit);
      }
      if (!view.tsumo) {
        expect(view.line.base, name).toBe(p.first);
      } else if (p.all) {
        expect(view.line.tsumoPay, name).toEqual({ child: p.first, dealer: p.first });
      } else {
        expect(view.line.tsumoPay, name).toEqual({ child: p.first, dealer: p.second });
      }
      // 親か子か（点数の文の「∀」は、親のツモだけ）
      expect(p.all, name).toBe(view.tsumo && view.dealer);
    }
    expect(limits.size).toBeGreaterThanOrEqual(3);
  });

  it('点の増減（本場・供託を含む）が、牌譜と一致する', () => {
    for (const { name, view } of wins) expect(view.deltasComputed, name).toEqual(view.deltas);
    expect(wins.filter((w) => w.view.honba > 0 || w.view.kyotaku > 0).length).toBeGreaterThan(5);
  });

  it('和了者の手牌: 閉じた手牌 + 副露 + 和了牌が 14 枚（槓は 1 つにつき 1 枚多い）で、和了牌を除いた手は聴牌の形で、待ちに和了牌が入っている', () => {
    for (const { name, view } of wins) {
      const meldTileCount = view.melds.reduce((sum, m) => sum + meldTiles(m).length, 0);
      const kans = view.melds.filter((m) => m.type === 'ankan' || m.type === 'daiminkan' || m.type === 'kakan').length;
      expect(view.closed.length + meldTileCount + 1, name).toBe(14 + kans);
      expect(view.closed, name).toEqual(sortTiles(view.closed));
      const waits = coreTenpaiWaits(view.closed, view.melds, view.winner);
      expect(waits, name).toContain(tileKind(view.winTile));
      expect(view.waits.map((w) => w.kind), name).toEqual(waits);
      expect(view.waits.every((w) => w.remaining >= 0 && w.remaining <= 4 && w.shapes.length > 0), name).toBe(true);
    }
  });

  it('放銃した局（本人が放銃者の和了）は、相手の手牌（閉じた手牌・副露・和了牌）と待ちが出る', () => {
    const dealIns = wins.filter((w) => !w.view.tsumo && w.view.target === w.game.playerId);
    expect(dealIns.length).toBeGreaterThan(5);
    for (const { name, view } of dealIns) {
      expect(view.winner, name).not.toBe(view.target);
      expect(view.closed.length, name).toBeGreaterThan(0);
      expect(view.waits.length, name).toBeGreaterThan(0);
      expect(view.waits.map((w) => w.kind), name).toContain(tileKind(view.winTile));
    }
  });
});

describe('E-40 局の結果の手: 流局は 4 人の手牌（荒牌平局は聴牌・ノーテン）', () => {
  const draws = allResults().filter((r) => r.result?.kind === 'draw');

  it('流局の局は、4 人の手牌が本人・下家・対面・上家の順に出る。荒牌平局では、聴牌の人に待ちがあり、聴牌の人の点が増えている', () => {
    expect(draws.length).toBeGreaterThan(8);
    let exhaustive = 0;
    for (const { id, game, position, result } of draws) {
      if (result?.kind !== 'draw') continue;
      const name = `${id} 局${position}`;
      expect(result.seats.map((s) => s.seat), name).toEqual([0, 1, 2, 3].map((o) => (game.playerId + o) % 4));
      if (!result.exhaustive) continue;
      exhaustive++;
      const deltas = game.report.review.kyokus[position]?.end_status[0]?.deltas as number[];
      const tenpai = result.seats.filter((s) => s.waits.length > 0).map((s) => s.seat);
      // 聴牌料: 聴牌の人は受け取り、ノーテンの人は払う（全員聴牌・全員ノーテンは、点が動かない）
      if (deltas.some((d) => d !== 0)) {
        for (const s of result.seats) expect(deltas[s.seat] !== undefined && (deltas[s.seat] as number) > 0, `${name} 席${s.seat}`).toBe(tenpai.includes(s.seat));
      } else {
        expect(tenpai.length === 0 || tenpai.length === 4, name).toBe(true);
      }
    }
    expect(exhaustive).toBeGreaterThan(8);
  });
});
