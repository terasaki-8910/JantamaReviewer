// @vitest-environment node
/**
 * 検討結果の取り込みの進め方（`importFlow.ts`）の試験。Rust 側のコマンドは偽物（`ImportDeps`）に差し替える。
 * 固定データは FX-4（10 月 9 日の半荘。結果 5b821c8a048ff791。迷いマーク 6 枚の文字認識の写し）。
 * エンジンの結びつけ（E-17・E-19・E-29）が、ここで取り込みの流れにつながることを確かめる。
 * FX-5（10 月 11 日の半荘）の取り込みで、時間の並びでの当てはめ（E-28〜E-30）と、評価の当てはめ方の版（E-31）も確かめる。
 */
import {
  importReportText,
  listDisagreements,
  summarizeHanchan,
} from '@jantama/engine';
import { describe, expect, it, vi } from 'vitest';

import { FX4_OCR, FX4_TEXT, FX5_ID, FX5_TEXT, OCR_GEOMETRY, fx4Ocr, fx4Session, fx5Ocr, fx5Session } from '../../tests/import-fixtures';
import type { Links, SessionRecord } from '../api/types';
import {
  CANDIDATE_WINDOW_MS,
  buildLinks,
  candidateSessions,
  completeImport,
  kyokuKey,
  markReadings,
  paipuDateText,
  prepareImport,
  ratingReadings,
  shortenMiddle,
  toSessionCandidate,
  type ImportDeps,
  type ImportStep,
} from './importFlow';

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function fakeDeps(
  sessions: SessionRecord[],
  overrides: Partial<ImportDeps> = {},
): ImportDeps & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const note = <T>(name: string, args: unknown[], result: T): T => {
    (calls[name] ??= []).push(args);
    return result;
  };
  const deps: ImportDeps = {
    listSessions: async () => note('listSessions', [], sessions),
    ocrSessions: async (ids) =>
      note(
        'ocrSessions',
        [ids],
        ids.map((id) => ({ session_id: id, ocr: fx4Ocr() })),
      ),
    saveReport: async (sessionId, text) =>
      note('saveReport', [sessionId, text], sessionId ?? '20261010-120000'),
    replaceLinks: async (sessionId, links) => note('replaceLinks', [sessionId, links], undefined),
    now: () => NOW,
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

describe('小さな部品', () => {
  it('局の鍵は、判断の鍵 k<局>h<本場>e<番号> の、局の部分と同じ作り方', () => {
    expect(kyokuKey(1, 1)).toBe('k1h1');
    expect(kyokuKey(0, 0)).toBe('k0h0');
    expect('k1h1e7'.startsWith(kyokuKey(1, 1))).toBe(true);
  });

  it('牌譜の ID の先頭の日付を「10月9日」の形にする。読めなければ null', () => {
    expect(paipuDateText('261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab')).toBe('10月9日');
    expect(paipuDateText('260101-abc')).toBe('1月1日');
    expect(paipuDateText('261309-abc')).toBeNull();
    expect(paipuDateText('261000-abc')).toBeNull();
    expect(paipuDateText('abc')).toBeNull();
    expect(paipuDateText('')).toBeNull();
  });

  it('長い文字列は、前と後ろを残して真ん中を省く', () => {
    expect(shortenMiddle('261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab', 11, 4)).toBe('261009-7c1e…89ab');
    expect(shortenMiddle('short')).toBe('short');
    expect(shortenMiddle('あいうえおかきくけこ', 3, 2)).toBe('あいう…けこ');
  });
});

describe('結びつけ先の候補', () => {
  it('結果が無い・直近 7 日の半荘だけ。新しい順', () => {
    const fresh = fx4Session('fresh', NOW - 2 * HOUR);
    const newer = fx4Session('newer', NOW - HOUR);
    const edge = fx4Session('edge', NOW - CANDIDATE_WINDOW_MS);
    const old = fx4Session('old', NOW - CANDIDATE_WINDOW_MS - 1);
    const done = fx4Session('done', NOW - HOUR, { report_path: 'C:\\data\\games\\done\\report.json' });
    const picked = candidateSessions([old, fresh, done, edge, newer], NOW);
    expect(picked.map((s) => s.id)).toEqual(['newer', 'fresh', 'edge']);
  });

  it('同じ時刻なら、名前の降順', () => {
    const a = fx4Session('20261009-190000', NOW - HOUR);
    const b = fx4Session('20261009-190000-2', NOW - HOUR);
    expect(candidateSessions([a, b], NOW).map((s) => s.id)).toEqual(['20261009-190000-2', '20261009-190000']);
  });

  it('迷いマークと評価の読み取りは、写しの行を画像のパスで引く。読めなかった画像は「読めない」扱い', () => {
    const session = fx4Session('s', NOW - HOUR);
    const cache = fx4Ocr();
    cache.entries['marks/m2.png'] = { lines: [], error: '画像を開けませんでした' };
    const marks = markReadings(session, cache);
    expect(marks).toHaveLength(6);
    expect(marks[0]?.lines).toEqual(FX4_OCR[0]?.lines);
    expect(marks[1]?.lines, '読めなかった画像').toBeUndefined();
    // 写しが無ければ、全部「読めない」
    expect(markReadings(session, null).every((m) => m.lines === undefined)).toBe(true);
    // 評価は、画像の写しが無いので「読めない」
    const ratings = ratingReadings(session, cache);
    expect(ratings.map((r) => r.id)).toEqual([7, 8, 9, 10, 11]);
    expect(ratings.every((r) => r.lines === undefined)).toBe(true);
    expect(ratings.map((r) => r.rating)).toEqual(['fair', 'bad', 'fair', 'bad', 'bad']);
  });

  it('保存した結びつけ（links）があれば、迷いに、利用者が選んだ結びつけ（chosen）を付ける。無ければ付けない', () => {
    const session = fx4Session('s', NOW - HOUR, { links: { marks: { '2': 'k1h0e12', '5': 'manual' }, ratings: {} } });
    expect(markReadings(session, null).map((m) => m.chosen)).toEqual([undefined, 'k1h0e12', undefined, undefined, 'manual', undefined]);
    expect(markReadings({ marks: session.marks }, null).every((m) => m.chosen === undefined)).toBe(true);
  });

  it('読み直し（retries）のある画像は、1 回目の行に加えて、読み直しの行も持つ（E-20）。無い画像は、持たない', () => {
    const session = fx4Session('s', NOW - HOUR);
    const marks = markReadings(session, fx4Ocr({ retries: true }));
    expect(marks[5]?.lines).toEqual(FX4_OCR[5]?.lines);
    expect(marks[5]?.retries).toEqual(FX4_OCR[5]?.retries?.map((r) => r.lines));
    expect(marks[0]?.retries).toBeUndefined();
    // 読めなかった（理由つき）画像は、読み直しの行があっても、読めない扱い
    const failed = fx4Ocr({ retries: true });
    failed.entries['marks/m6.png'] = { lines: [], retries: [{ variant: 'contrast1.8', lines: ['東 3 局'] }], error: '画像を開けませんでした' };
    expect(markReadings(session, failed)[5]).toEqual({ id: 6, t_ms: session.marks[5]?.t_ms });
  });

  it('半荘の候補は、迷いマークと評価の両方の読み取りを持つ', () => {
    const session = fx4Session('s', NOW - HOUR);
    const candidate = toSessionCandidate(session, fx4Ocr());
    expect(candidate.id).toBe('s');
    expect(candidate.started_ms).toBe(session.started_ms);
    expect(candidate.marks).toHaveLength(11);
    expect(candidate.marks.slice(0, 6).every((m) => m.lines !== undefined)).toBe(true);
    expect(candidate.marks.slice(6).every((m) => m.lines === undefined)).toBe(true);
  });
});

describe('prepareImport: 検査・読み取り・結びつけ先の決定', () => {
  it('JSON として読めない結果は、読めなかったと伝えて、何も読み込まない', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)]);
    const result = await prepareImport(deps, '<html>error</html>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.title).toBe('結果の JSON を読めませんでした');
    expect(result.failure.message).toContain('JSON');
    expect(deps.calls['listSessions']).toBeUndefined();
    expect(deps.calls['ocrSessions']).toBeUndefined();
  });

  it('牌譜を再生して検討結果と合わなければ、局と巡目を含む理由つきで止める', async () => {
    const broken = JSON.parse(FX4_TEXT) as {
      review: { kyokus: Array<{ entries: Array<{ state: { tehai: string[] } }> }> };
    };
    broken.review.kyokus[0]!.entries[0]!.state.tehai[0] = '9s';
    broken.review.kyokus[0]!.entries[0]!.state.tehai[1] = '9s';
    broken.review.kyokus[0]!.entries[0]!.state.tehai[2] = '9s';
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)]);
    const result = await prepareImport(deps, JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.title).toBe('牌譜と検討結果が合いません');
    expect(result.failure.message).toMatch(/東1局 \d+巡目/);
    expect(deps.calls['ocrSessions']).toBeUndefined();
  });

  it('結果の無い半荘が無ければ、画像は読まずに「新しい半荘」にする', async () => {
    const deps = fakeDeps([fx4Session('done', NOW - HOUR, { report_path: 'x' })]);
    const steps: ImportStep[] = [];
    const result = await prepareImport(deps, FX4_TEXT, (step) => steps.push(step));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.match).toEqual({ kind: 'new' });
    expect(deps.calls['ocrSessions']).toBeUndefined();
    expect(steps).toEqual(['checking']);
  });

  it('局と点数が合う半荘が 1 つなら、画像を読んで、その半荘に決める', async () => {
    const deps = fakeDeps([fx4Session('20261009-190953', NOW - 17 * HOUR)]);
    const steps: ImportStep[] = [];
    const result = await prepareImport(deps, FX4_TEXT, (step) => steps.push(step));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.match).toEqual({ kind: 'match', sessionId: '20261009-190953' });
    expect(deps.calls['ocrSessions']).toEqual([[['20261009-190953']]]);
    expect(steps).toEqual(['checking', 'reading']);
    expect(result.context.ocrWarning).toBeNull();
  });

  it('合う半荘が 2 つ以上なら、新しい順の一覧から選んでもらう', async () => {
    const deps = fakeDeps([
      fx4Session('older', NOW - 20 * HOUR),
      fx4Session('newer', NOW - 10 * HOUR),
    ]);
    const result = await prepareImport(deps, FX4_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.match).toEqual({
      kind: 'choose',
      sessionIds: ['newer', 'older'],
      matchingIds: ['newer', 'older'],
    });
  });

  it('局と点数が合う半荘が無ければ、結果の無い半荘を新しい順に全部出す', async () => {
    const other = fx4Session('other', NOW - 5 * HOUR);
    const deps = fakeDeps([other], {
      ocrSessions: async (ids) =>
        ids.map((id) => ({
          session_id: id,
          // 別の半荘のスクショ（点数が合わない）
          ocr: {
            geometry: OCR_GEOMETRY,
            entries: { 'marks/m1.png': { lines: ['東 1 局', '个 5 9', '17000'] } },
          },
        })),
    });
    const result = await prepareImport(deps, FX4_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.match).toEqual({ kind: 'choose', sessionIds: ['other'], matchingIds: [] });
  });

  it('文字認識が使えなくても取り込みは続け、理由を添えて、半荘を選んでもらう', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)], {
      ocrSessions: async () => {
        throw 'Windows の日本語の文字認識が使えません。';
      },
    });
    const result = await prepareImport(deps, FX4_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.ocrWarning).toContain('日本語の文字認識が使えません');
    expect(result.context.match).toMatchObject({ kind: 'choose', matchingIds: [] });
  });

  it('半荘の一覧を読めなければ、失敗として止める', async () => {
    const deps = fakeDeps([], {
      listSessions: async () => {
        throw new Error('保存先を開けません');
      },
    });
    const result = await prepareImport(deps, FX4_TEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.title).toBe('半荘の一覧を読めませんでした');
    expect(result.failure.message).toBe('保存先を開けません');
  });
});

describe('completeImport: 保存・結びつけ・まとめ', () => {
  async function prepared(deps: ImportDeps) {
    const result = await prepareImport(deps, FX4_TEXT);
    if (!result.ok) throw new Error(result.failure.message);
    return result.context;
  }

  it('結果を保存し、自動で決めた結びつけを書いて、Rating・不一致・結びつけの数を返す', async () => {
    const deps = fakeDeps([fx4Session('20261009-190953', NOW - 17 * HOUR)]);
    const context = await prepared(deps);
    const summary = await completeImport(deps, context, '20261009-190953');

    expect(deps.calls['saveReport']).toEqual([['20261009-190953', FX4_TEXT]]);
    // 迷いマークの結びつけは、保存しない（推定は、読み取りの写しと結果から出せる。保存するのは、利用者が選んだものだけ）。
    // 評価は、迷いと評価を押した時刻の順に、局へ（E-29）。19:22:41 の評価は、押し直しなので当てはめない（空の文字列）。
    // 当てはめ方の版（ratings_version）も書く（E-31）。
    const expected: Links = {
      marks: {},
      ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': '', '11': 'k2h1' },
      ratings_version: 2,
    };
    expect(deps.calls['replaceLinks']).toEqual([['20261009-190953', expected]]);

    const imported = importReportText(FX4_TEXT);
    if (!imported.ok) throw new Error(imported.error.message);
    const hanchan = summarizeHanchan(imported.value.report);
    expect(summary).toMatchObject({
      sessionId: '20261009-190953',
      startedMs: NOW - 17 * HOUR,
      linkedToRecording: true,
      room: '玉の間・南',
      ratingText: '93.0',
      grade: hanchan.grade,
      decisionCount: 70,
      disagreementCount: listDisagreements(imported.value.decisions).total,
      markCount: 6,
      // 読めた迷い 1〜5 は、1 位を推定として結びつける。読めない迷い 6 は、局だけ分かる（東3局1本場）が、巡目が決まらないので、
      // 判断を選ぶまでは、手で選んでほしい数に入れる。
      estimatedMarks: 5,
      manualMarks: 1,
      ratingCount: 5,
      placedRatings: 4,
      warnings: [],
    });
    expect(summary.disagreementCount).toBeGreaterThan(0);
    expect(summary.grade).not.toBeNull();
  });

  it('選んだ半荘に結びつけるときも、同じ。選んだ半荘の読み取りを使う', async () => {
    const deps = fakeDeps([fx4Session('a', NOW - 20 * HOUR), fx4Session('b', NOW - 10 * HOUR)]);
    const context = await prepared(deps);
    const summary = await completeImport(deps, context, 'a');
    expect(summary.sessionId).toBe('a');
    expect(summary.startedMs).toBe(NOW - 20 * HOUR);
    expect(summary.estimatedMarks).toBe(5);
    expect(deps.calls['saveReport']).toEqual([['a', FX4_TEXT]]);
  });

  it('記録の無い半荘として取り込むときは、新しい半荘に保存して、迷いも評価も 0。結びつけは書かない', async () => {
    const deps = fakeDeps([]);
    const context = await prepared(deps);
    const summary = await completeImport(deps, context, null);
    expect(deps.calls['saveReport']).toEqual([[null, FX4_TEXT]]);
    expect(deps.calls['replaceLinks']).toBeUndefined();
    expect(summary).toMatchObject({
      sessionId: '20261010-120000',
      startedMs: NOW,
      linkedToRecording: false,
      markCount: 0,
      estimatedMarks: 0,
      manualMarks: 0,
      ratingCount: 0,
      placedRatings: 0,
      ratingText: '93.0',
    });
  });

  it('結びつけを保存できなくても、結果は保存済みなので、知らせを添えて完了にする', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)], {
      replaceLinks: async () => {
        throw 'ディスクがいっぱいです';
      },
    });
    const context = await prepared(deps);
    const summary = await completeImport(deps, context, 's');
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('結びつけを保存できませんでした');
    expect(summary.warnings[0]).toContain('ディスクがいっぱいです');
  });

  it('文字認識が使えなかったときは、その知らせを添える', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)], {
      ocrSessions: async () => {
        throw new Error('日本語の言語パックがありません');
      },
    });
    const context = await prepared(deps);
    const summary = await completeImport(deps, context, 's');
    expect(summary.warnings.join('\n')).toContain('日本語の言語パックがありません');
    // 迷いマークは読み取れていないので、推定は 0、手で選んでほしいのは 6。評価は押した順に当てはめる。
    expect(summary).toMatchObject({ markCount: 6, estimatedMarks: 0, manualMarks: 6, placedRatings: 5 });
  });

  it('E-20 読み直しの写しがあれば、1 回目で読めなかった迷い 6 も推定になる（推定 6・手で選ぶ 0）', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)], {
      ocrSessions: async (ids) => ids.map((id) => ({ session_id: id, ocr: fx4Ocr({ retries: true }) })),
    });
    const context = await prepared(deps);
    const summary = await completeImport(deps, context, 's');
    expect(summary).toMatchObject({ markCount: 6, estimatedMarks: 6, manualMarks: 0 });
  });

  it('結果の保存に失敗したときは、例外を投げて、結びつけは書かない', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)], {
      saveReport: async () => {
        throw new Error('この半荘には、すでに結果が取り込まれています');
      },
    });
    const context = await prepared(deps);
    await expect(completeImport(deps, context, 's')).rejects.toThrow('すでに結果が取り込まれています');
    expect(deps.calls['replaceLinks']).toBeUndefined();
  });

  it('結びつけ先の一覧に無い半荘は、保存する前に断る', async () => {
    const deps = fakeDeps([fx4Session('s', NOW - HOUR)]);
    const context = await prepared(deps);
    const saveReport = vi.spyOn(deps, 'saveReport');
    await expect(completeImport(deps, context, 'unknown')).rejects.toThrow('結びつけ先の一覧にありません');
    expect(saveReport).not.toHaveBeenCalled();
  });
});

describe('U-14 その半荘に取り込む（結びつけ先が決まっているとき。結びつけ先の照合はしない）', () => {
  const ID = '20261009-190953';

  it('指定した半荘だけを読み取って、その半荘に結びつける（ほかの半荘は見ない。直近 7 日の外でも）', async () => {
    const old = fx4Session(ID, NOW - 30 * 24 * HOUR);
    const other = fx4Session('other', NOW - HOUR);
    const deps = fakeDeps([other, old]);
    const steps: ImportStep[] = [];
    const result = await prepareImport(deps, FX4_TEXT, (step) => steps.push(step), { target: ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.calls['ocrSessions']).toEqual([[[ID]]]);
    expect(result.context.match).toEqual({ kind: 'match', sessionId: ID });
    expect(result.context.sessions.map((s) => s.id)).toEqual([ID]);
    expect(steps).toEqual(['checking', 'reading']);
    expect(result.context.targetCheck).toEqual({ sessionId: ID, readable: 5, fitting: 5, mismatches: [] });
  });

  it('読めたスクショがすべて結果と合えば、食い違いは無い。読み直しで読めた迷い 6 も数える', async () => {
    const deps = fakeDeps([fx4Session(ID, NOW - HOUR)], {
      ocrSessions: async (ids) => ids.map((id) => ({ session_id: id, ocr: fx4Ocr({ retries: true }) })),
    });
    const result = await prepareImport(deps, FX4_TEXT, undefined, { target: ID });
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.context.targetCheck).toEqual({ sessionId: ID, readable: 6, fitting: 6, mismatches: [] });
  });

  it('結果と合わないスクショは、迷い・評価の呼び名と、読んだ内容を返す（局が違う・点数が違う）', async () => {
    const session = fx4Session(ID, NOW - HOUR);
    const cache = fx4Ocr();
    cache.entries['marks/m2.png'] = { lines: ['南 2 局', '个 4 0', '25000'] };
    cache.entries['marks/m4.png'] = { lines: ['東 2 局', '个 3 5', '17000'] };
    cache.entries['ratings/r3.png'] = { lines: ['西 1 局', '个 6 0', '25000'] };
    const deps = fakeDeps([session], { ocrSessions: async (ids) => ids.map((id) => ({ session_id: id, ocr: cache })) });
    const result = await prepareImport(deps, FX4_TEXT, undefined, { target: ID });
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.context.targetCheck).toEqual({
      sessionId: ID,
      readable: 6,
      fitting: 3,
      mismatches: [
        { label: '迷い2', reading: '南2局・残り40・25,000点' },
        { label: '迷い4', reading: '東2局・残り35・17,000点' },
        { label: '評価3局目', reading: '西1局・残り60・25,000点' },
      ],
    });
  });

  it('何も読めなければ（文字認識が使えない）、食い違いは言えない。理由を添えて、そのまま進められる', async () => {
    const deps = fakeDeps([fx4Session(ID, NOW - HOUR)], {
      ocrSessions: async () => {
        throw 'Windows の日本語の文字認識が使えません。';
      },
    });
    const result = await prepareImport(deps, FX4_TEXT, undefined, { target: ID });
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.context.ocrWarning).toContain('日本語の文字認識が使えません');
    expect(result.context.targetCheck).toEqual({ sessionId: ID, readable: 0, fitting: 0, mismatches: [] });
  });

  it('指定した半荘が無い・すでに結果が入っているときは、画像を読まずに失敗にする', async () => {
    const done = fx4Session(ID, NOW - HOUR, { report_path: 'C:\\data\\games\\x\\report.json' });
    const deps = fakeDeps([done]);
    const already = await prepareImport(deps, FX4_TEXT, undefined, { target: ID });
    expect(already.ok).toBe(false);
    if (!already.ok) expect(already.failure.title).toBe('この半荘には、すでに結果が取り込まれています');
    const missing = await prepareImport(deps, FX4_TEXT, undefined, { target: 'nothing' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.title).toBe('取り込む半荘が見つかりません');
    expect(deps.calls['ocrSessions']).toBeUndefined();
  });

  it('牌譜と結果が合わないときは、半荘を調べる前に止める（結びつけ先が決まっていても同じ）', async () => {
    const deps = fakeDeps([fx4Session(ID, NOW - HOUR)]);
    const result = await prepareImport(deps, '<html>error</html>', undefined, { target: ID });
    expect(result.ok).toBe(false);
    expect(deps.calls['listSessions']).toBeUndefined();
  });

  it('指定した半荘に保存して、結びつけを書く。結びつけ先の照合の結果が合わなくても、ここでは保存を止めない（聞くのは画面）', async () => {
    const cache = fx4Ocr();
    cache.entries['marks/m2.png'] = { lines: ['南 2 局', '个 4 0', '25000'] };
    const deps = fakeDeps([fx4Session(ID, NOW - 17 * HOUR), fx4Session('newer', NOW - HOUR)], {
      ocrSessions: async (ids) => ids.map((id) => ({ session_id: id, ocr: cache })),
    });
    const result = await prepareImport(deps, FX4_TEXT, undefined, { target: ID });
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.context.targetCheck?.mismatches).toHaveLength(1);
    const summary = await completeImport(deps, result.context, ID);
    expect(deps.calls['saveReport']).toEqual([[ID, FX4_TEXT]]);
    expect(summary).toMatchObject({ sessionId: ID, linkedToRecording: true, markCount: 6, placedRatings: 4 });
    // 合わなかった迷い 2 は、1 枚の読み取りが「この半荘に合う局が無い」ので、手で選ぶ。読めた 4 枚は推定
    expect(summary).toMatchObject({ estimatedMarks: 4, manualMarks: 2 });
  });
});

describe('buildLinks', () => {
  it('どの局にも当てはめられなかった評価は、空の文字列（どの局にも結びつけない）で保存する', async () => {
    const imported = importReportText(FX4_TEXT);
    if (!imported.ok) throw new Error(imported.error.message);
    const report = imported.value.report;
    const links = buildLinks(report, {
      status: 'tooMany',
      handCount: 5,
      ratingCount: 2,
      assigned: [],
      extra: [],
      missingHands: [],
      message: '',
      placements: [
        {
          rating: { id: 7, t_ms: 1, rating: 'good' as const },
          order: 0,
          center: null,
          reading: null,
          position: 4,
          how: 'order',
          unplaced: null,
        },
        {
          rating: { id: 8, t_ms: 2, rating: 'bad' as const },
          order: 1,
          center: null,
          reading: null,
          position: null,
          how: null,
          unplaced: 'no-room',
        },
      ],
    });
    // 評価の当てはめ方の版（ratings_version）も書く（E-31）
    expect(links).toEqual({ marks: {}, ratings: { '7': 'k2h1', '8': '' }, ratings_version: 2 });
  });

  it('評価が無い（当てはめていない）ときは、結びつけは空で、版も書かない', () => {
    const imported = importReportText(FX4_TEXT);
    if (!imported.ok) throw new Error(imported.error.message);
    expect(buildLinks(imported.value.report, null)).toEqual({ marks: {}, ratings: {} });
  });
});

describe('E-29〜E-31 FX-5（10月11日の半荘）の取り込み: 迷いと評価を押した時刻の順に当てはめて、評価の結びつけを版つきで保存する', () => {
  const ID = FX5_ID;

  async function importFx5() {
    const deps = fakeDeps([fx5Session(ID, NOW - 3 * HOUR)], {
      ocrSessions: async (ids) => ids.map((id) => ({ session_id: id, ocr: fx5Ocr() })),
    });
    const result = await prepareImport(deps, FX5_TEXT);
    if (!result.ok) throw new Error(result.failure.message);
    const summary = await completeImport(deps, result.context, ID);
    return { deps, summary };
  }

  it('評価 9 つが FX-5 の評価の局に入る（東3局は空欄）。評価の id → 局の鍵と、版 2 を保存する。迷いの結びつけは保存しない', async () => {
    const { deps } = await importFx5();
    expect(deps.calls['replaceLinks']).toEqual([
      [
        ID,
        {
          marks: {},
          ratings: {
            // 東1局・東2局・東3局1本場・東4局・東4局1本場・南1局2本場・南2局・南3局・南4局（k2h0 = 東3局は無い）
            '1': 'k0h0',
            '5': 'k1h0',
            '7': 'k2h1',
            '11': 'k3h0',
            '12': 'k3h1',
            '15': 'k4h2',
            '18': 'k5h0',
            '20': 'k6h0',
            '22': 'k7h0',
          },
          ratings_version: 2,
        },
      ],
    ]);
  });

  it('まとめ: 迷い 13 のうち、推定は 11。局だけ分かった 2 つ（15:38:10・15:42:37）は、判断を選ぶまで、手で選んでほしい数に入れる', async () => {
    const { summary } = await importFx5();
    expect(summary).toMatchObject({
      sessionId: ID,
      linkedToRecording: true,
      decisionCount: 125,
      markCount: 13,
      estimatedMarks: 11,
      manualMarks: 2,
      ratingCount: 9,
      placedRatings: 9,
      warnings: [],
    });
  });
});
