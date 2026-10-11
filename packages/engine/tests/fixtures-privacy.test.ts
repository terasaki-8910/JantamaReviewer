import { describe, expect, it } from 'vitest';

import { FX1_IDS, FX4_ID, loadFixtureJson, loadReportJson, loadReportText } from './helpers/fixtures';

// 結果 JSON の固定データ（FX-1 の5半荘と FX-4）をリポジトリに入れてよいかの検査。
// 雀魂の牌譜 ID・アカウントの番号・本名が入っていないことを、コミットの前にテストで確かめる。
describe('固定データ（FX-1・FX-4）に個人を特定できる値が入っていない', () => {
  for (const id of [...FX1_IDS, FX4_ID]) {
    describe(id, () => {
      const text = loadReportText(id);

      it('雀魂の牌譜 ID（日付-UUID の形）が無い', () => {
        expect(text).not.toMatch(/\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(text).not.toMatch(/\d{6}-[0-9a-f]{8}-/i);
      });

      it('牌譜リンク・雀魂のドメイン・アカウントの番号（_a の後ろの数字）が無い', () => {
        expect(text).not.toMatch(/paipu/i);
        expect(text).not.toMatch(/mahjong-?soul|maj-?soul|yo-star/i);
        expect(text).not.toMatch(/_a\d+/);
        expect(text).not.toMatch(/account|nickname|user_?id/i);
      });

      it('絵文字として扱われる文字（段位の星など）は、JSON のエスケープで書いてある（リポジトリの絵文字の走査に掛からない）', () => {
        // 星（U+2605）は Extended_Pictographic に入る。apps/desktop の L-2 の走査は packages 以下の JSON も見るので、
        // 値は同じまま、ファイルの中の字を \u2605 の書き方にしてある。
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(text).toContain(`${String.fromCharCode(92)}u2605`);
        const stars = JSON.stringify(loadReportJson(id)).match(new RegExp(String.fromCharCode(0x2605), 'g'));
        expect(stars?.length).toBeGreaterThan(0);
      });

      it('プレイヤー名はすべて「Aさん」「Bさん」「Cさん」「Dさん」に置き換わっている', () => {
        const placeholder = ['Aさん', 'Bさん', 'Cさん', 'Dさん'];
        const json = loadReportJson(id) as {
          mjai_log: { type: string; names?: string[] }[];
          split_logs: { name?: string[] }[];
        };
        const starts = json.mjai_log.filter((e) => e.type === 'start_game');
        expect(starts).toHaveLength(1);
        expect(starts[0]?.names).toEqual(placeholder);
        expect(json.split_logs.length).toBeGreaterThan(0);
        for (const log of json.split_logs) {
          expect(log.name).toEqual(placeholder);
        }
      });
    });
  }
});

describe('FX-4 の文字認識の写し（fx4-ocr.json）に個人を特定できる値が入っていない', () => {
  const text = JSON.stringify(loadFixtureJson('fx4-ocr.json'));

  it('牌譜リンク・雀魂のドメイン・アカウントの番号・プレイヤー名が無い', () => {
    expect(text).not.toMatch(/paipu|mahjong-?soul|maj-?soul|yo-star/i);
    expect(text).not.toMatch(/_a\d+|account|nickname|user_?id/i);
    expect(text).not.toMatch(/[A-D]さん/);
    expect(text).not.toMatch(/\d{6}-[0-9a-f]{8}-/i);
  });

  it('絵文字として扱われる文字が無い', () => {
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('FX-6 の文字認識の写し（fx6-ocr.json）に個人を特定できる値が入っていない', () => {
  const text = JSON.stringify(loadFixtureJson('fx6-ocr.json'));

  it('牌譜リンク・雀魂のドメイン・アカウントの番号・プレイヤー名・保存先のパスが無い', () => {
    expect(text).not.toMatch(/paipu|mahjong-?soul|maj-?soul|yo-star/i);
    expect(text).not.toMatch(/_a\d+|account|nickname|user_?id/i);
    expect(text).not.toMatch(/[A-D]さん/);
    expect(text).not.toMatch(/\d{6}-[0-9a-f]{8}-/i);
    expect(text).not.toMatch(/Users|JantamaReviewerData|[A-Za-z]:[\/]/);
  });

  it('絵文字として扱われる文字が無い', () => {
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
