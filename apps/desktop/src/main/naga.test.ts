/**
 * NAGA の結果の欄（F22 段 2。ACCEPTANCE の U-52・E-51）の、画面にも Tauri にも依存しない決まりの試験:
 * 貼った文字の確かめ（Rust 側の `checked_naga_url` と同じ決まり）と、保存・消去の取り消せる命令。
 * 画面の動きは NagaSection.test.tsx、実ブラウザでの見え方は tests/browser/hanchan.browser.test.ts・replay.browser.test.ts が確かめる。
 */
import { describe, expect, it, vi } from 'vitest';

import { NAGA_HOST, NAGA_URL_INVALID, NAGA_URL_PLACEHOLDER, isNagaUrl } from './naga';
import { nagaCommand } from './nagaEdits';
import { UndoStack } from './undo/undoStack';

const REPORT_URL = 'https://naga.dmv.nico/htmls/report_viewer.html?report_id=abc';

describe('E-51 貼った文字が NAGA の結果のページの URL か', () => {
  it('NAGA のサイトの https の URL は通す（前後の空白・大文字のホスト・既定のポート・ホストだけの URL も）', () => {
    for (const text of [
      REPORT_URL,
      `  ${REPORT_URL}\n`,
      'HTTPS://NAGA.DMV.NICO/htmls/report_viewer.html?report_id=abc',
      'https://naga.dmv.nico',
      'https://naga.dmv.nico:443/reports/abc.json?x=1#top',
      'https://naga.dmv.nico/a b',
    ]) {
      expect(isNagaUrl(text), text).toBe(true);
    }
  });

  it('http・別のサイト・似たホスト・ユーザー名つき・別のポート・URL でないもの・空は通さない', () => {
    for (const text of [
      'http://naga.dmv.nico/htmls/report_viewer.html?report_id=abc',
      'https://evil.example/htmls/report_viewer.html?report_id=abc',
      'https://naga.dmv.nico.evil.example/htmls/report_viewer.html?report_id=abc',
      'https://evil.example/https://naga.dmv.nico/',
      'https://www.naga.dmv.nico/x',
      'https://xnaga.dmv.nico/x',
      'https://dmv.nico/x',
      'https://naga.dmv.nico./x',
      'https://naga.dmv.nico@evil.example/x',
      'https://user@naga.dmv.nico/x',
      'https://user:pass@naga.dmv.nico/x',
      'https://naga.dmv.nico:8443/x',
      'https://127.0.0.1/x',
      'ftp://naga.dmv.nico/x',
      'javascript:alert(1)',
      'file:///c:/windows/system32/calc.exe',
      '//naga.dmv.nico/x',
      'naga.dmv.nico/x',
      'abc',
      'https://',
      '',
      '   ',
    ]) {
      expect(isNagaUrl(text), text).toBe(false);
    }
  });

  it('入力欄の見本と、断るときの理由の文に、NAGA のサイトの名前が入る（ソースに URL を書かずに組み立てた文字）', () => {
    expect(NAGA_HOST).toBe('naga.dmv.nico');
    expect(NAGA_URL_PLACEHOLDER).toBe('https://naga.dmv.nico/…');
    expect(NAGA_URL_INVALID).toBe('NAGA の結果のページの URL（https://naga.dmv.nico/ で始まるもの）を貼ってください');
  });
});

describe('U-11・U-52 NAGA の結果の保存・消去の取り消し', () => {
  const edit = { sessionId: '20261009-190953', before: null, after: REPORT_URL };

  it('実行で URL を保存し、取り消すと消し、やり直すともう一度保存する。そのたびに半荘の一覧を読み直す', async () => {
    const api = { setNagaUrl: vi.fn(async () => undefined) };
    const reload = vi.fn(async () => undefined);
    const stack = new UndoStack();
    await stack.run(nagaCommand(api, reload, edit));
    expect(api.setNagaUrl).toHaveBeenLastCalledWith('20261009-190953', REPORT_URL);
    expect(reload).toHaveBeenCalledTimes(1);
    await stack.undo();
    expect(api.setNagaUrl).toHaveBeenLastCalledWith('20261009-190953', null);
    await stack.redo();
    expect(api.setNagaUrl).toHaveBeenLastCalledWith('20261009-190953', REPORT_URL);
    expect(api.setNagaUrl).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('消す操作は、取り消すと前の URL を入れ直す（前の形に戻る）', async () => {
    const api = { setNagaUrl: vi.fn(async () => undefined) };
    const stack = new UndoStack();
    await stack.run(nagaCommand(api, async () => undefined, { ...edit, before: REPORT_URL, after: null }));
    expect(api.setNagaUrl).toHaveBeenLastCalledWith('20261009-190953', null);
    await stack.undo();
    expect(api.setNagaUrl).toHaveBeenLastCalledWith('20261009-190953', REPORT_URL);
    await stack.redo();
    expect(api.setNagaUrl).toHaveBeenLastCalledWith('20261009-190953', null);
  });

  it('通知の文: 保存・消去は「NAGA の結果を保存しました」「NAGA の結果を消しました」。取り消しは、何を元に戻したかを言う', () => {
    const save = nagaCommand({ setNagaUrl: vi.fn() }, vi.fn(), edit);
    expect(save.label).toBe('NAGA の結果の保存');
    expect(save.messages).toEqual({
      run: 'NAGA の結果を保存しました',
      undo: 'NAGA の結果の保存を元に戻しました',
      redo: 'NAGA の結果を保存しました',
    });
    const remove = nagaCommand({ setNagaUrl: vi.fn() }, vi.fn(), { ...edit, before: REPORT_URL, after: null });
    expect(remove.label).toBe('NAGA の結果の削除');
    expect(remove.messages).toEqual({
      run: 'NAGA の結果を消しました',
      undo: 'NAGA の結果の削除を元に戻しました',
      redo: 'NAGA の結果を消しました',
    });
  });

  it('保存に失敗したら、積まない（理由のまま投げる）。一覧も読み直さない', async () => {
    const api = {
      setNagaUrl: vi.fn(async () => {
        throw NAGA_URL_INVALID;
      }),
    };
    const reload = vi.fn(async () => undefined);
    const stack = new UndoStack();
    await expect(stack.run(nagaCommand(api, reload, edit))).rejects.toBe(NAGA_URL_INVALID);
    expect(stack.canUndo).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
