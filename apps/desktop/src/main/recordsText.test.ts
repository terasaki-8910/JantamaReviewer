import { describe, expect, it } from 'vitest';

import {
  countsText,
  defaultRecordsName,
  exportedMessage,
  fileNameOf,
  formatSize,
  heldSentence,
  importedMessage,
} from './recordsText';

describe('記録の書き出しの文言と整え方（D-2）', () => {
  it('既定のファイルの名前は、ローカルの日付の jantama-records-YYYYMMDD.json（月と日は 2 桁）', () => {
    expect(defaultRecordsName(new Date(2026, 9, 12, 23, 59))).toBe('jantama-records-20261012.json');
    expect(defaultRecordsName(new Date(2026, 0, 5, 0, 1))).toBe('jantama-records-20260105.json');
  });

  it('パスのファイルの名前の部分を取る（区切りは \\ も / も）', () => {
    expect(fileNameOf('C:\\Users\\test\\Documents\\a.json')).toBe('a.json');
    expect(fileNameOf('/home/test/a.json')).toBe('a.json');
    expect(fileNameOf('a.json')).toBe('a.json');
  });

  it('大きさは「約 N KB」「約 N.N MB」。0 バイトでも 1 KB と出す', () => {
    expect(formatSize(0)).toBe('約 1 KB');
    expect(formatSize(1_500)).toBe('約 1 KB');
    expect(formatSize(420_000)).toBe('約 410 KB');
    expect(formatSize(1024 * 1024)).toBe('約 1.0 MB');
    expect(formatSize(420_000 * 3)).toBe('約 1.2 MB');
  });

  it('書き出したあとの知らせは、見本のとおり', () => {
    expect(exportedMessage('jantama-records-20261011.json', 420_000)).toBe(
      '書き出しました。jantama-records-20261011.json（約 410 KB）',
    );
  });

  it('読み込んだあとの知らせは、見本のとおり。取っておく半荘があれば、その件数を足す', () => {
    const base = '読み込みました（半荘 12・答え 84）。スクショと Mortal の結果は、データの保存先にあるものを使います。';
    expect(importedMessage({ sessions: 12, answers: 84, held: 0 })).toBe(base);
    expect(importedMessage({ sessions: 12, answers: 84, held: 3 })).toBe(
      `${base}保存先に無い半荘 3 件の記録は、そのフォルダを保存先に写したときに付きます。`,
    );
  });

  it('確認の数と、取っておく半荘の 1 文（無ければ null）', () => {
    expect(countsText({ sessions: 12, answers: 84 })).toBe('（半荘 12・答え 84）');
    expect(heldSentence(0)).toBeNull();
    expect(heldSentence(1)).toBe('保存先に無い半荘が 1 件あります。そのフォルダを保存先に写すと、記録が付きます。');
  });
});
