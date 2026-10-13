import { describe, expect, it } from 'vitest';

import { hanchanStatOf, totalStats, type HanchanStat } from '../src/hanchan-stats';
import { importReportText } from '../src/import';
import type { MortalReport, Seat } from '../src/report-types';
import { FX1_IDS, FX4_ID, FX5_ID, loadMutableReport, loadReportText, type LooseJson } from './helpers/fixtures';

// E-42 取り込んだ半荘からの成績（F14、R15-7）: 固定データの 7 半荘で、4位率・放銃率・平均順位・和了率・副露率・立直率・平均和了点とその「もとの数」が、
// 承認済みの見本の値（majiang-ui の stat.js と同じ数え方で、見本づくりの道具が数えたもの）と一致する。
// さらに、このテストの中で、牌譜（結果 JSON の split_logs の局の結果と、mjai_log の event）から、コードを通さずに数え直した値とも、半荘ごとに全部一致する。
// ごみ箱の半荘を数えない確かめは、週の集計の側（apps/desktop の importedStats の試験）。

const IDS = [FX4_ID, FX5_ID, ...FX1_IDS];

function load(id: string): MortalReport {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value.report;
}

const statsOf = (ids: readonly string[]): HanchanStat[] =>
  ids.map((id) => {
    const stat = hanchanStatOf(load(id));
    if (stat === null) throw new Error(`数えられなかった半荘: ${id}`);
    return stat;
  });

// ---- 牌譜からの数え直し（コードを通さない） ----

interface Counted {
  kyokuCount: number;
  winCount: number;
  dealInCount: number;
  riichiCount: number;
  fulouCount: number;
  winPointsSum: number;
  rank: number;
  /** 暗槓だけをして、チー・ポン・大明槓をしなかった局の数。 */
  ankanOnlyKyokus: number;
}

/** 点数の文の、全員の支払いの合計: 「30符1飜1000点」（ロン）「跳満3000-6000点」（子のツモ）「30符2飜700点∀」（親のツモ）。 */
function totalOfPointsText(text: string, winner: number, dealer: number): number {
  const pay = /(\d+)(?:-(\d+))?点(∀)?$/.exec(text);
  if (pay === null) throw new Error(`知らない点数の書き方: ${text}`);
  const first = Number(pay[1]);
  if (pay[3] !== undefined) return first * 3;
  if (pay[2] !== undefined) {
    expect(winner, `${text}: 2 つの数が付くのは子のツモ`).not.toBe(dealer);
    return first * 2 + Number(pay[2]);
  }
  return first;
}

/** 牌譜から数え直す。局の結果（和了・放銃・点数・点の増減）は split_logs（tenhou.net/6 形式）、立直・副露・成立した立直の棒は mjai_log から。 */
function countFromPaipu(report: MortalReport): Counted {
  const me = report.player_id;
  const counted: Counted = {
    kyokuCount: report.split_logs.length,
    winCount: 0,
    dealInCount: 0,
    riichiCount: 0,
    fulouCount: 0,
    winPointsSum: 0,
    rank: 0,
    ankanOnlyKyokus: 0,
  };
  let lastDeltas: number[] = [0, 0, 0, 0];
  for (const split of report.split_logs as Array<{ log: unknown[][] }>) {
    const log = split.log[0] as unknown[];
    const head = log[0] as [number, number, number];
    const dealer = head[0] % 4;
    const result = log[log.length - 1] as unknown[];
    const deltas = [0, 0, 0, 0];
    let dealtIn = false;
    if (result[0] === '和了') {
      for (let i = 1; i < result.length; i += 2) {
        (result[i] as number[]).forEach((delta, seat) => (deltas[seat] = (deltas[seat] ?? 0) + delta));
        const info = result[i + 1] as [number, number, number, string];
        const [winner, target] = info;
        if (winner === me) {
          counted.winCount += 1;
          counted.winPointsSum += totalOfPointsText(info[3], winner, dealer);
        }
        if (winner !== me && target === me) dealtIn = true;
      }
    } else if (Array.isArray(result[1])) {
      (result[1] as number[]).forEach((delta, seat) => (deltas[seat] = delta));
    }
    if (dealtIn) counted.dealInCount += 1;
    lastDeltas = deltas;
  }

  // 立直・副露は、局ごとに、mjai の event から
  let riichi = false;
  let fulou = false;
  let ankan = false;
  const closeKyoku = () => {
    if (riichi) counted.riichiCount += 1;
    if (fulou) counted.fulouCount += 1;
    if (ankan && !fulou) counted.ankanOnlyKyokus += 1;
    riichi = false;
    fulou = false;
    ankan = false;
  };
  let started = false;
  let lastStart: number[] = [];
  let sticks = [0, 0, 0, 0];
  for (const event of report.mjai_log) {
    if (event.type === 'start_kyoku') {
      if (started) closeKyoku();
      started = true;
      lastStart = event.scores;
      sticks = [0, 0, 0, 0];
    }
    if (!started) continue;
    if (event.type === 'reach' && event.actor === me) riichi = true;
    if (event.type === 'reach_accepted') sticks[event.actor] = (sticks[event.actor] ?? 0) + 1000;
    if ((event.type === 'chi' || event.type === 'pon' || event.type === 'daiminkan') && event.actor === me) fulou = true;
    if (event.type === 'ankan' && event.actor === me) ankan = true;
  }
  closeKyoku();

  // 順位: 最後の局の始めの点数 + 局の結果の点の増減 - 成立した立直の棒。同点は席の番号が小さいほうが上
  const finals = lastStart.map((score, seat) => score + (lastDeltas[seat] ?? 0) - (sticks[seat] ?? 0));
  counted.rank = 1 + finals.filter((score, seat) => score > (finals[me] as number) || (score === finals[me] && seat < me)).length;
  return counted;
}

const toCounted = (stat: HanchanStat): Omit<Counted, 'ankanOnlyKyokus'> => ({
  kyokuCount: stat.kyokuCount,
  winCount: stat.winCount,
  dealInCount: stat.dealInCount,
  riichiCount: stat.riichiCount,
  fulouCount: stat.fulouCount,
  winPointsSum: stat.winPointsSum,
  rank: stat.rank,
});

describe('E-42 取り込んだ半荘からの成績: 固定データの 7 半荘', () => {
  it('4位率・放銃率・平均順位・和了率・副露率・立直率・平均和了点とその「もとの数」が、見本の値と一致する', () => {
    const total = totalStats(statsOf(IDS));
    // もとの数（見本の表の「もとの数」の列）
    expect(total).toMatchObject({
      hanchanCount: 7,
      kyokuCount: 82,
      fourthCount: 2,
      rankSum: 19,
      dealInCount: 9,
      winCount: 16,
      fulouCount: 24,
      riichiCount: 16,
      winPointsSum: 110_800,
    });
    // 値（見本の表の「値」の列。表示の桁）
    expect((total.fourthRate as number).toFixed(1)).toBe('28.6');
    expect((total.dealInRate as number).toFixed(1)).toBe('11.0');
    expect((total.averageRank as number).toFixed(2)).toBe('2.71');
    expect((total.winRate as number).toFixed(1)).toBe('19.5');
    expect((total.fulouRate as number).toFixed(1)).toBe('29.3');
    expect((total.riichiRate as number).toFixed(1)).toBe('19.5');
    expect(total.averageWinPoints).toBe(6925);
  });

  it('半荘ごとの数と順位が、牌譜（split_logs の局の結果と mjai_log）から数え直した値と、全部一致する', () => {
    for (const id of IDS) {
      const report = load(id);
      const stat = hanchanStatOf(report);
      expect(stat, id).not.toBeNull();
      const { ankanOnlyKyokus: _ankanOnly, ...counted } = countFromPaipu(report);
      expect(toCounted(stat as HanchanStat), id).toEqual(counted);
    }
  });

  it('7 半荘をまとめた値も、牌譜から数え直した合計から出した値と一致する', () => {
    const counted = IDS.map((id) => countFromPaipu(load(id)));
    const sum = (pick: (c: Counted) => number) => counted.reduce((total, c) => total + pick(c), 0);
    const total = totalStats(statsOf(IDS));
    expect(total.kyokuCount).toBe(sum((c) => c.kyokuCount));
    expect(total.fourthRate).toBeCloseTo((counted.filter((c) => c.rank === 4).length / 7) * 100, 10);
    expect(total.averageRank).toBeCloseTo(sum((c) => c.rank) / 7, 10);
    expect(total.dealInRate).toBeCloseTo((sum((c) => c.dealInCount) / sum((c) => c.kyokuCount)) * 100, 10);
    expect(total.winRate).toBeCloseTo((sum((c) => c.winCount) / sum((c) => c.kyokuCount)) * 100, 10);
    expect(total.fulouRate).toBeCloseTo((sum((c) => c.fulouCount) / sum((c) => c.kyokuCount)) * 100, 10);
    expect(total.riichiRate).toBeCloseTo((sum((c) => c.riichiCount) / sum((c) => c.kyokuCount)) * 100, 10);
    expect(total.averageWinPoints).toBeCloseTo(sum((c) => c.winPointsSum) / sum((c) => c.winCount), 10);
  });

  it('暗槓だけをした局は、副露に数えない（固定データに、暗槓だけの局がある）', () => {
    const ankanOnly = IDS.map((id) => countFromPaipu(load(id)).ankanOnlyKyokus).reduce((a, b) => a + b, 0);
    expect(ankanOnly).toBeGreaterThan(0);
  });

  it('半荘ごとの値は、1 半荘だけを渡しても出る（半荘ごとの表の元）', () => {
    const fx4 = totalStats(statsOf([FX4_ID]));
    expect(fx4).toMatchObject({ hanchanCount: 1, fourthCount: 1, rankSum: 4, winCount: 1, winPointsSum: 1000, averageWinPoints: 1000 });
  });
});

describe('E-42 半荘の無い週・和了の無い半荘', () => {
  it('半荘が 0 のとき、数はすべて 0、値はすべて null', () => {
    const total = totalStats([]);
    expect(total).toEqual({
      hanchanCount: 0,
      kyokuCount: 0,
      fourthCount: 0,
      rankSum: 0,
      winCount: 0,
      dealInCount: 0,
      fulouCount: 0,
      riichiCount: 0,
      winPointsSum: 0,
      fourthRate: null,
      dealInRate: null,
      averageRank: null,
      winRate: null,
      fulouRate: null,
      riichiRate: null,
      averageWinPoints: null,
    });
  });

  it('和了が 1 回も無いとき、平均和了点だけが null（率は 0%）', () => {
    const stat: HanchanStat = { rank: 3, kyokuCount: 8, winCount: 0, dealInCount: 0, riichiCount: 0, fulouCount: 0, winPointsSum: 0 };
    const total = totalStats([stat]);
    expect(total.averageWinPoints).toBeNull();
    expect(total.winRate).toBe(0);
    expect(total.averageRank).toBe(3);
  });

  it('牌譜が局の終わりを持たず、局を再生できない半荘は、数えられない（null）', () => {
    const report = loadMutableReport(FX4_ID) as LooseJson;
    report.mjai_log = report.mjai_log.filter((e: { type: string }) => e.type !== 'hora' && e.type !== 'ryukyoku');
    expect(hanchanStatOf(report as MortalReport)).toBeNull();
  });

  it('局が無い半荘は、数えられない（null）', () => {
    const report = loadMutableReport(FX4_ID) as LooseJson;
    report.mjai_log = [];
    expect(hanchanStatOf(report as MortalReport)).toBeNull();
  });
});

describe('E-42 順位の決め方（最後の局の点数から。同点は起家に近い席が上。立直の棒は引く）', () => {
  /** 最後の局の始めの点数を書き換えた複製（結果は、最後の局の点の増減が足される）。 */
  function withLastStart(id: string, edit: (scores: number[]) => void, player?: Seat): MortalReport {
    const report = loadMutableReport(id) as LooseJson;
    const starts = report.mjai_log.filter((e: { type: string }) => e.type === 'start_kyoku');
    edit(starts[starts.length - 1].scores);
    if (player !== undefined) report.player_id = player;
    return report as MortalReport;
  }

  it('もとの順位: FX-4 の本人（席 0）は 4 位、f738 の本人（席 3）は 3 位', () => {
    expect(hanchanStatOf(load(FX4_ID))?.rank).toBe(4);
    expect(hanchanStatOf(load(FX1_IDS[1]))?.rank).toBe(3);
  });

  it('同点で、本人の席のほうが小さければ上（席 0 が席 3 と同点の 41400 点 → 1 位）', () => {
    // FX-4 の最後の点数は -3900, 33700, 28800, 41400（席 0 が本人）。席 0 の始めの点数を 45300 点上げると、41400 で席 3 と並ぶ
    const stat = hanchanStatOf(withLastStart(FX4_ID, (scores) => (scores[0] = (scores[0] as number) + 45_300)));
    expect(stat?.rank).toBe(1);
  });

  it('同点で、本人の席のほうが大きければ下（席 3 が席 2 と同点の 47300 点 → 2 位）', () => {
    // f738 の最後の点数は 27600, -2100, 47300, 27200（席 3 が本人）。席 3 の始めの点数を 20100 点上げると、47300 で席 2 と並ぶ
    const stat = hanchanStatOf(withLastStart(FX1_IDS[1], (scores) => (scores[3] = (scores[3] as number) + 20_100)));
    expect(stat?.rank).toBe(2);
  });

  it('最後の局で成立した立直の棒（1000 点）を引いてから比べる（引かないと 2 位、引くと 3 位）', () => {
    // 20261011-153540（本人は席 0）の最後の局は、席 0 が立直して 1 000 点の棒を出している。牌譜の点の増減だけの点数は 28500 だが、棒を引くと 27500。
    // 席 1 の最後の点数（19600）を、8000 点上げて 27600 にすると、棒を引いた本人の 27500 を上回る
    const stat = hanchanStatOf(withLastStart(FX5_ID, (scores) => (scores[1] = (scores[1] as number) + 8000)));
    expect(stat?.rank).toBe(3);
  });
});

describe('E-42 ダブロン（手で作った 1 局の半荘）: 和了は和了者それぞれに数え、放銃は 1 局に 1 回', () => {
  // 親（席 0）が 5p を切り、席 1 と席 2 が同時にロンした。
  //   席 1: 234m 567m 345s 88s と 4p6p（嵌張待ち）。断幺九だけの 40 符 1 飜（子）= 1300 点
  //   席 2: 234m 678m 345s 66s と 3p4p（両面待ち）。平和・断幺九の 30 符 2 飜（子）= 2000 点
  const tehais = [
    ['1m', '1m', '9m', '9m', '1p', '9p', '1s', '9s', 'E', 'S', 'W', 'N', 'P'],
    ['2m', '3m', '4m', '5m', '6m', '7m', '3s', '4s', '5s', '4p', '6p', '8s', '8s'],
    ['3p', '4p', '2m', '3m', '4m', '6m', '7m', '8m', '3s', '4s', '5s', '6s', '6s'],
    ['1m', '9m', '2p', '2p', '7p', '7p', '1s', '9s', 'E', 'S', 'W', 'N', 'F'],
  ];
  const deltas1 = [-1300, 1300, 0, 0];
  const deltas2 = [-2000, 0, 2000, 0];

  function doubleRon(player: Seat): MortalReport {
    return {
      engine: 'Mortal',
      game_length: 'Hanchan',
      version: 'test',
      review: {
        total_reviewed: 0,
        total_matches: 0,
        rating: 1,
        temperature: 0.1,
        kyokus: [
          {
            kyoku: 0,
            honba: 0,
            end_status: [
              { type: 'hora', actor: 1, target: 0, deltas: deltas1 },
              { type: 'hora', actor: 2, target: 0, deltas: deltas2 },
            ],
            relative_scores: [25000, 25000, 25000, 25000],
            entries: [],
          },
        ],
        relative_phi_matrix: [[[0.25, 0.25, 0.25, 0.25]]],
        model_tag: 'test',
      },
      player_id: player,
      split_logs: [],
      mjai_log: [
        { type: 'start_game', names: ['A', 'B', 'C', 'D'] },
        { type: 'start_kyoku', bakaze: 'E', dora_marker: 'C', kyoku: 1, honba: 0, kyotaku: 0, oya: 0, scores: [25000, 25000, 25000, 25000], tehais },
        { type: 'tsumo', actor: 0, pai: '5p' },
        { type: 'dahai', actor: 0, pai: '5p', tsumogiri: true },
        { type: 'hora', actor: 1, target: 0, deltas: deltas1 },
        { type: 'hora', actor: 2, target: 0, deltas: deltas2 },
        { type: 'end_kyoku' },
        { type: 'end_game' },
      ],
    } as MortalReport;
  }

  it('放銃した親（席 0）: 放銃 1（2 人にロンされても 1 局に 1 回）、和了 0、4 位', () => {
    expect(hanchanStatOf(doubleRon(0))).toEqual({ rank: 4, kyokuCount: 1, winCount: 0, dealInCount: 1, riichiCount: 0, fulouCount: 0, winPointsSum: 0 });
  });

  it('席 1: 和了 1（1300 点）、放銃 0、2 位', () => {
    expect(hanchanStatOf(doubleRon(1))).toEqual({ rank: 2, kyokuCount: 1, winCount: 1, dealInCount: 0, riichiCount: 0, fulouCount: 0, winPointsSum: 1300 });
  });

  it('席 2: 和了 1（2000 点）、放銃 0、1 位', () => {
    expect(hanchanStatOf(doubleRon(2))).toEqual({ rank: 1, kyokuCount: 1, winCount: 1, dealInCount: 0, riichiCount: 0, fulouCount: 0, winPointsSum: 2000 });
  });

  it('関係のない席 3: 和了 0・放銃 0、3 位', () => {
    expect(hanchanStatOf(doubleRon(3))).toEqual({ rank: 3, kyokuCount: 1, winCount: 0, dealInCount: 0, riichiCount: 0, fulouCount: 0, winPointsSum: 0 });
  });
});
