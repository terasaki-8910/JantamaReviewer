// @vitest-environment node
/**
 * 検討結果の取り込みの進め方（`importFlow.ts`）の試験。Rust 側のコマンドは偽物（`ImportDeps`）に差し替える。
 * 固定データは FX-4（10 月 9 日の半荘。結果 5b821c8a048ff791。迷いマーク 6 枚の文字認識の写し）。
 * エンジンの結びつけ（E-17・E-18・E-19）が、ここで取り込みの流れにつながることを確かめる。
 */
import {
  importReportText,
  listDisagreements,
  summarizeHanchan,
} from '@jantama/engine';
import { describe, expect, it, vi } from 'vitest';

import { FX4_OCR, FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
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
    expect(ratings.map((r) => r.rating)).toEqual(['good', 'fair', 'good', 'bad', 'fair']);
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
            geometry: 'center-v1-lanczos3x',
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
    // 迷い 1〜3 は 1 つに決まる。迷い 4・5 は候補が複数、迷い 6 は読めない（どれも保存しない）。評価は押した順で局へ。
    const expected: Links = {
      marks: { '1': 'k0h0e4', '2': 'k1h0e13', '3': 'k1h1e7' },
      ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
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
      linkedMarks: 3,
      choiceMarks: 3,
      ratingCount: 5,
      placedRatings: 5,
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
    expect(summary.linkedMarks).toBe(3);
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
      linkedMarks: 0,
      choiceMarks: 0,
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
    // 迷いマークは読み取れていないので、結びつけは 0、選んでほしいのは 6。評価は押した順に当てはめる。
    expect(summary).toMatchObject({ markCount: 6, linkedMarks: 0, choiceMarks: 6, placedRatings: 5 });
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

describe('buildLinks', () => {
  it('どの局にも当てはめられなかった評価は、空の文字列（どの局にも結びつけない）で保存する', async () => {
    const imported = importReportText(FX4_TEXT);
    if (!imported.ok) throw new Error(imported.error.message);
    const report = imported.value.report;
    const links = buildLinks(report, [], {
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
          position: 4,
          how: 'order',
          unplaced: null,
        },
        {
          rating: { id: 8, t_ms: 2, rating: 'bad' as const },
          order: 1,
          center: null,
          position: null,
          how: null,
          unplaced: 'no-room',
        },
      ],
    });
    expect(links).toEqual({ marks: {}, ratings: { '7': 'k2h1', '8': '' } });
  });
});
