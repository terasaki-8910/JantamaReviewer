/**
 * 迷いの画像の大きな表示に渡す項目（半荘のページの迷いのカードと、出題・通して見る画面の「迷いのスクショ」の欄が同じ文を出す）。
 */
import { describe, expect, it, vi } from 'vitest';

import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { game } from '../../../tests/study-harness';
import { resolveMarks } from '../markCards';
import { viewerItemOf } from '../viewerItems';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://${path}` }));

const session = fx4Session('sess', 0, { report_path: 'r.json', ocr: fx4Ocr() });
const resolved = resolveMarks(game('fx4').report, session);

describe('画像の大きな表示の項目', () => {
  it('画像のある迷い: 場所・読み上げ・下の文（迷いのカードの 2 行目と同じ）・撮った時刻', () => {
    const item = viewerItemOf(session.marks[2]!, 3, resolved[2] ?? null);
    expect(item).toEqual({
      src: 'asset://C:\\data\\games\\sess\\marks\\m3.png',
      alt: '迷い3のスクリーンショット',
      caption: expect.stringMatching(/^迷い3 · 東2局1本場 · \d+巡目 · 打牌の迷い · 推定$/),
      time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
    });
  });

  it('取り込み前（結びつけが無い）は、「迷いN」だけ。撮れなかった迷い（画像なし）は項目にならない', () => {
    expect(viewerItemOf(session.marks[0]!, 1, null)?.caption).toBe('迷い1');
    expect(viewerItemOf({ ...session.marks[0]!, screenshot_path: null }, 1, null)).toBeNull();
  });
});
