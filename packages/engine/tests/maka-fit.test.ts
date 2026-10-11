import { describe, expect, it } from 'vitest';

import { DEFAULT_GRADE_MODEL } from '../src/default-grade-model';
import { type Grade, GRADES, evaluateLeaveOneGameOut, fitGradeModel, predictGrade } from '../src/grade';
import { summarizeHanchan } from '../src/hanchan-summary';
import {
  type FitKyoku,
  type FitSession,
  type UserMakaGrade,
  SCORE_MATCH_EPSILON,
  baseGradeRecords,
  baseMakaFit,
  baseScore,
  fitMaka,
  gameNamesOf,
  makaFitRecords,
  matchBaseGame,
  percentOf,
} from '../src/maka-fit';
import { MAKA_BASE_RECORDS } from '../src/maka-fit-base';
import { parseReportText } from '../src/report';
import { FX1_IDS, FX4_ID, loadReportText } from './helpers/fixtures';

/** 取り込んだ半荘の、点数のある局（アプリが、半荘のまとめから作るのと同じもの）。 */
function kyokusOf(id: string): FitKyoku[] {
  const parsed = parseReportText(loadReportText(id));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return summarizeHanchan(parsed.value)
    .kyokus.filter((k) => k.rating !== null)
    .map((k) => ({ label: k.label, score: (k.rating as number) * 100 }));
}

const F9DA = 'f9da87cbcd7af5e9';
const percents = (fit: ReturnType<typeof fitMaka>) => [percentOf(fit.exact), percentOf(fit.withinOne)];

describe('U-31 基礎の記録だけの当てはめ（利用者の評価が 0 件）', () => {
  it('67 局・ぴったり 34%・±1段階以内 66%（E-13 の値）で、既定の当てはめと完全に同じモデル', () => {
    const fit = fitMaka();
    expect(fit.recordCount).toBe(67);
    expect(fit.userCount).toBe(0);
    expect(fit.replacedCount).toBe(0);
    expect(percents(fit)).toEqual([34, 66]);
    expect(fit.model).toEqual(DEFAULT_GRADE_MODEL);
    expect(baseMakaFit().recordCount).toBe(67);
    expect(percents(baseMakaFit())).toEqual([34, 66]);
  });

  it('基礎の記録は、半荘 5 つの 67 局。点数は dataset.csv の Rating の 100 倍', () => {
    const records = baseGradeRecords();
    expect(records).toHaveLength(67);
    expect(new Set(records.map((r) => r.game)).size).toBe(5);
    expect(records.map((r) => r.score)).toEqual(MAKA_BASE_RECORDS.map(baseScore));
    expect(evaluateLeaveOneGameOut(records)?.agreement.count).toBe(67);
  });
});

describe('U-31 取り込んだ半荘と、基礎の半荘の突き合わせ（中身で突き合わせる）', () => {
  it('FX-1 の 5 半荘は、それぞれ基礎の同じ半荘に当たる（局の名前と点数が全部同じ）', () => {
    for (const id of FX1_IDS) expect(matchBaseGame(kyokusOf(id)), id).toBe(id);
  });

  it('基礎に無い半荘（FX-4）は、どれにも当たらない', () => {
    expect(matchBaseGame(kyokusOf(FX4_ID))).toBeNull();
    expect(matchBaseGame([])).toBeNull();
  });

  it('1 局でも点数が違う・局が足りない・多いときは、当たらない（Rating 100% の局が同じ名前で重なっても取り違えない）', () => {
    const own = kyokusOf(F9DA);
    expect(matchBaseGame(own)).toBe(F9DA);
    expect(matchBaseGame(own.map((k, i) => (i === 3 ? { ...k, score: k.score + 0.01 } : k)))).toBeNull();
    expect(matchBaseGame(own.slice(1))).toBeNull();
    expect(matchBaseGame([...own, { label: '西2局', score: 90 }])).toBeNull();
    // 100% の 東1局 は 基礎の 3 つの半荘にある。それだけでは、どれとも決まらない
    expect(matchBaseGame([{ label: '東1局', score: 100 }])).toBeNull();
  });

  it('点数の差が SCORE_MATCH_EPSILON 以内なら同じ点数とみなす（同じ結果から別の道筋で計算した誤差）', () => {
    const own = kyokusOf(F9DA);
    expect(matchBaseGame(own.map((k) => ({ ...k, score: k.score + SCORE_MATCH_EPSILON / 2 })))).toBe(F9DA);
    expect(matchBaseGame(own.map((k) => ({ ...k, score: k.score + SCORE_MATCH_EPSILON * 10 })))).toBeNull();
  });

  it('半荘の名前 → 当てはめでの半荘: 基礎と同じ半荘は基礎の名前、そうでなければ半荘ごとに別', () => {
    const sessions: FitSession[] = [
      { sessionId: '20261009-171200', kyokus: kyokusOf(F9DA) },
      { sessionId: '20261009-190953', kyokus: kyokusOf(FX4_ID) },
    ];
    expect([...gameNamesOf(sessions)]).toEqual([
      ['20261009-171200', F9DA],
      ['20261009-190953', 'session:20261009-190953'],
    ]);
  });
});

describe('U-31 利用者の MAKA の評価を入れて当てはめ直す', () => {
  const fx4 = kyokusOf(FX4_ID);
  const fx4Session: FitSession = { sessionId: '20261009-190953', kyokus: fx4 };
  const gradeOn = (sessionId: string, k: FitKyoku, grade: Grade): UserMakaGrade => ({ sessionId, ...k, grade });

  it('基礎に無い半荘の評価を 1 つ入れると、記録が 68 局になり、モデルと見込みが替わる', () => {
    const user = gradeOn(fx4Session.sessionId, fx4[2] as FitKyoku, 'A-');
    const fit = fitMaka([user], [fx4Session]);
    expect(fit.recordCount).toBe(68);
    expect(fit.userCount).toBe(1);
    expect(fit.replacedCount).toBe(0);
    expect(fit.model.recordCount).toBe(68);
    expect(fit.model).not.toEqual(DEFAULT_GRADE_MODEL);
    // 見込みは、新しい半荘も 1 つの半荘として外して確かめた値（6 半荘・68 局）
    const records = makaFitRecords([user], [fx4Session]).records;
    expect(new Set(records.map((r) => r.game)).size).toBe(6);
    const loo = evaluateLeaveOneGameOut(records);
    expect(fit.exact).toBe(loo?.agreement.exact);
    expect(fit.withinOne).toBe(loo?.agreement.withinOne);
    expect(fit.model).toEqual(fitGradeModel(records));
  });

  it('評価を 1 つ足すたびに、局数が 1 ずつ増える（同じ局を入れ直しても増えない）', () => {
    const grades: UserMakaGrade[] = [];
    const counts: number[] = [];
    for (const [i, g] of (['S', 'A', 'B', 'C', 'D'] as const).entries()) {
      grades.push(gradeOn(fx4Session.sessionId, fx4[i] as FitKyoku, g));
      counts.push(fitMaka(grades, [fx4Session]).recordCount);
    }
    expect(counts).toEqual([68, 69, 70, 71, 72]);
    // 同じ局に 2 つ渡すと、あとのもの 1 つだけ
    const twice = [gradeOn(fx4Session.sessionId, fx4[0] as FitKyoku, 'S'), gradeOn(fx4Session.sessionId, fx4[0] as FitKyoku, 'D')];
    const records = makaFitRecords(twice, [fx4Session]).records;
    expect(records).toHaveLength(68);
    expect(records.at(-1)?.grade).toBe('D');
  });

  it('基礎の半荘の局に評価を入れると、その基礎の記録を置き換える（記録は 67 局のまま。同じ半荘として外れる）', () => {
    const own = kyokusOf(F9DA);
    const session: FitSession = { sessionId: '20261009-171200', kyokus: own };
    const baseGrade = MAKA_BASE_RECORDS.find((r) => r.game === F9DA && r.label === '東2局')?.grade as Grade;
    expect(baseGrade).toBe('S');
    const user = gradeOn(session.sessionId, own[1] as FitKyoku, 'D');
    const { records, replaced } = makaFitRecords([user], [session]);
    expect(replaced).toBe(1);
    expect(records).toHaveLength(67);
    expect(records.filter((r) => r.game === F9DA)).toHaveLength(12);
    expect(records[1]).toEqual({ game: F9DA, score: user.score, grade: 'D' });
    expect(records.filter((r, i) => i !== 1 && r.grade !== MAKA_BASE_RECORDS[i]?.grade)).toEqual([]);
    const fit = fitMaka([user], [session]);
    expect(fit.recordCount).toBe(67);
    expect(fit.userCount).toBe(1);
    expect(fit.replacedCount).toBe(1);
    expect(fit.model).not.toEqual(DEFAULT_GRADE_MODEL);
    // 基礎と同じ評価を入れ直しても、モデルは変わらない
    const same = fitMaka([gradeOn(session.sessionId, own[1] as FitKyoku, baseGrade)], [session]);
    expect(same.model).toEqual(DEFAULT_GRADE_MODEL);
    expect(percents(same)).toEqual([34, 66]);
  });

  it('基礎の半荘の、基礎に無い評価（別の局の名前）は、足される', () => {
    const own = kyokusOf(F9DA);
    const session: FitSession = { sessionId: 's', kyokus: own };
    const extra: UserMakaGrade = { sessionId: 's', label: '西4局', score: 90, grade: 'B' };
    const { records, replaced } = makaFitRecords([extra], [session]);
    expect(replaced).toBe(0);
    expect(records).toHaveLength(68);
    expect(records.at(-1)).toEqual({ game: F9DA, score: 90, grade: 'B' });
  });

  it('評価を消す（利用者の評価が無くなる）と、基礎だけの当てはめに戻る', () => {
    const withOne = fitMaka([gradeOn(fx4Session.sessionId, fx4[0] as FitKyoku, 'D')], [fx4Session]);
    const none = fitMaka([], [fx4Session]);
    expect(withOne.recordCount).toBe(68);
    expect(none.model).toEqual(DEFAULT_GRADE_MODEL);
    expect(percents(none)).toEqual([34, 66]);
  });

  it('当てはめ直したモデルは単調（点数が上がって段階が下がらない）', () => {
    const fit = fitMaka(
      fx4.map((k, i) => gradeOn(fx4Session.sessionId, k, (['S', 'C', 'B', 'D', 'A'] as const)[i] as Grade)),
      [fx4Session],
    );
    let prev = -1;
    for (let score = 0; score <= 100; score += 0.1) {
      const index = GRADES.indexOf(predictGrade(fit.model, score));
      expect(index).toBeGreaterThanOrEqual(prev);
      prev = index;
    }
  });

  it('percentOf は四捨五入。確かめられない（null・NaN）ときは null', () => {
    expect(percentOf(0.345)).toBe(35);
    expect(percentOf(0.3432)).toBe(34);
    expect(percentOf(null)).toBeNull();
    expect(percentOf(Number.NaN)).toBeNull();
  });
});

describe('U-31 当てはめ直しは速い（局が 200 のとき）', () => {
  it('基礎の 67 局 + 利用者の 133 局（12 半荘）の当てはめと半荘ごとの検証が、1 回 100 ミリ秒以内', () => {
    // 作り物: 局の名前と点数と評価を、決まった式で作る（乱数は使わない）
    const sessions: FitSession[] = [];
    const users: UserMakaGrade[] = [];
    for (let s = 0; s < 12; s += 1) {
      const kyokus: FitKyoku[] = [];
      for (let k = 0; k < 11 + (s % 2); k += 1) {
        const kyoku = { label: `東${(k % 4) + 1}局${Math.floor(k / 4)}本場`, score: 55 + ((s * 37 + k * 23) % 450) / 10 };
        kyokus.push(kyoku);
        const index = Math.min(13, Math.max(0, Math.round((kyoku.score - 50) / 3.8) + ((s + k) % 3) - 1));
        users.push({ sessionId: `s${s}`, ...kyoku, grade: GRADES[index] as Grade });
      }
      sessions.push({ sessionId: `s${s}`, kyokus });
    }
    expect(users.length).toBeGreaterThanOrEqual(133);
    const used = users.slice(0, 133);
    expect(fitMaka(used, sessions).recordCount).toBe(200);
    const times: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const start = performance.now();
      fitMaka(used, sessions);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[3] as number;
    console.log(`fitMaka（200 局・13 半荘）の時間: 中央値 ${median.toFixed(2)} ms、最大 ${(times[6] as number).toFixed(2)} ms`);
    expect(median).toBeLessThan(100);
  });
});
