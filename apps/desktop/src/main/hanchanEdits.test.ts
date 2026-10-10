import { describe, expect, it } from 'vitest';

import { makaCommand, markLinkCommand, selfRatingCommand, type EditApi } from './hanchanEdits';
import { UndoStack } from './undo/undoStack';

/** 呼ばれた保存を、順に記録するだけの窓口。 */
function fakeApi(log: string[], failOn?: string): EditApi {
  const record = (text: string) => async () => {
    if (failOn !== undefined && text.startsWith(failOn)) throw new Error('保存できません');
    log.push(text);
  };
  return {
    setMarkLink: (s, id, decision) => record(`setMarkLink ${s} ${id} ${decision}`)(),
    clearMarkLink: (s, id) => record(`clearMarkLink ${s} ${id}`)(),
    setSelfRating: (s, k, r) => record(`setSelfRating ${s} ${k} ${r}`)(),
    clearSelfRating: (s, k) => record(`clearSelfRating ${s} ${k}`)(),
    setMakaGrade: (s, k, g) => record(`setMakaGrade ${s} ${k} ${g}`)(),
    clearMakaGrade: (s, k) => record(`clearMakaGrade ${s} ${k}`)(),
    setMakaHanchan: (s, g) => record(`setMakaHanchan ${s} ${g}`)(),
    clearMakaHanchan: (s) => record(`clearMakaHanchan ${s}`)(),
  };
}

const SESSION = '20261009-190953';

describe('U-11 迷いの結びつけの命令', () => {
  const edit = { sessionId: SESSION, markId: 4, number: 4, where: '東2局1本場 9巡目', after: 'k1h1e11' };

  it('最初の選び（元は何も保存していない）: 実行で保存し、取り消すと「保存しない状態」（clear）に戻る。やり直すと、また保存する', async () => {
    const log: string[] = [];
    let reloads = 0;
    const stack = new UndoStack();
    const command = markLinkCommand(fakeApi(log), async () => void (reloads += 1), { ...edit, before: undefined });
    await stack.run(command);
    expect(log).toEqual([`setMarkLink ${SESSION} 4 k1h1e11`]);
    await stack.undo();
    expect(log.at(-1)).toBe(`clearMarkLink ${SESSION} 4`);
    await stack.redo();
    expect(log.at(-1)).toBe(`setMarkLink ${SESSION} 4 k1h1e11`);
    expect(log).toHaveLength(3);
    expect(reloads).toBe(3);
  });

  it('選び直し（元は別の判断を保存してあった）: 取り消すと、前の判断をそのまま保存し直す', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(markLinkCommand(fakeApi(log), async () => undefined, { ...edit, before: 'k1h1e10' }));
    await stack.undo();
    expect(log).toEqual([`setMarkLink ${SESSION} 4 k1h1e11`, `setMarkLink ${SESSION} 4 k1h1e10`]);
  });

  it('通知の文: 実行・やり直しは「迷いNを…に結びつけました」、取り消しは「…を元に戻しました」。名前は「迷いの結びつけ」', () => {
    const command = markLinkCommand(fakeApi([]), async () => undefined, { ...edit, before: undefined });
    expect(command.label).toBe('迷いの結びつけ');
    expect(command.messages).toEqual({
      run: '迷い4を東2局1本場 9巡目の局面に結びつけました',
      undo: '迷い4の結びつけを元に戻しました',
      redo: '迷い4を東2局1本場 9巡目の局面に結びつけました',
    });
  });

  it('保存できなかったときは、積み重ねに載らない（取り消せるものが増えない）', async () => {
    const stack = new UndoStack();
    const command = markLinkCommand(fakeApi([], 'setMarkLink'), async () => undefined, { ...edit, before: undefined });
    await expect(stack.run(command)).rejects.toThrow('保存できません');
    expect(stack.canUndo).toBe(false);
  });
});

describe('U-11 局の自分の〇△✕の命令', () => {
  const edit = { sessionId: SESSION, kyoku: 'k1h0', label: '東2局' };

  it('付け直す（元の上書きは無い）: 実行で上書きを保存し、取り消すと、上書きを消して、ウィジェットの評価に戻す', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(selfRatingCommand(fakeApi(log), async () => undefined, { ...edit, before: undefined, after: 'good' }));
    await stack.undo();
    await stack.redo();
    expect(log).toEqual([
      `setSelfRating ${SESSION} k1h0 good`,
      `clearSelfRating ${SESSION} k1h0`,
      `setSelfRating ${SESSION} k1h0 good`,
    ]);
  });

  it('上書きを付け直す: 取り消すと、前の上書きの値に戻す（none も、1 つの値）', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(selfRatingCommand(fakeApi(log), async () => undefined, { ...edit, before: 'none', after: 'fair' }));
    await stack.undo();
    expect(log).toEqual([`setSelfRating ${SESSION} k1h0 fair`, `setSelfRating ${SESSION} k1h0 none`]);
  });

  it('通知の文: 「東2局の自分の評価を✕にしました」。評価なしは「…をなしにしました」', () => {
    const bad = selfRatingCommand(fakeApi([]), async () => undefined, { ...edit, before: undefined, after: 'bad' });
    expect(bad.label).toBe('局の評価の付け直し');
    expect(bad.messages?.run).toBe('東2局の自分の評価を✕にしました');
    expect(bad.messages?.undo).toBe('東2局の自分の評価を元に戻しました');
    const none = selfRatingCommand(fakeApi([]), async () => undefined, { ...edit, before: 'bad', after: 'none' });
    expect(none.messages?.run).toBe('東2局の自分の評価をなしにしました');
    const fair = selfRatingCommand(fakeApi([]), async () => undefined, { ...edit, before: undefined, after: 'fair' });
    expect(fair.messages?.run).toBe('東2局の自分の評価を△にしました');
    const good = selfRatingCommand(fakeApi([]), async () => undefined, { ...edit, before: undefined, after: 'good' });
    expect(good.messages?.run).toBe('東2局の自分の評価を〇にしました');
  });
});

describe('U-11 MAKA の評価の命令', () => {
  it('局の MAKA を入れる: 取り消すと、消す（clear）。元の段階があれば、その段階に戻す', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    const api = fakeApi(log);
    const none = () => Promise.resolve();
    await stack.run(makaCommand(api, none, { sessionId: SESSION, kyoku: 'k0h0', label: '東1局', before: undefined, after: 'S+' }));
    await stack.undo();
    await stack.run(makaCommand(api, none, { sessionId: SESSION, kyoku: 'k0h0', label: '東1局', before: 'B', after: 'S+' }));
    await stack.undo();
    expect(log).toEqual([
      `setMakaGrade ${SESSION} k0h0 S+`,
      `clearMakaGrade ${SESSION} k0h0`,
      `setMakaGrade ${SESSION} k0h0 S+`,
      `setMakaGrade ${SESSION} k0h0 B`,
    ]);
  });

  it('消す（after が空）: 実行で clear、取り消すと元の段階を入れ直す', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(
      makaCommand(fakeApi(log), async () => undefined, { sessionId: SESSION, kyoku: 'k0h0', label: '東1局', before: 'C', after: undefined }),
    );
    await stack.undo();
    expect(log).toEqual([`clearMakaGrade ${SESSION} k0h0`, `setMakaGrade ${SESSION} k0h0 C`]);
  });

  it('半荘全体の MAKA は、別の保存（setMakaHanchan・clearMakaHanchan）を使う', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    const edit = { sessionId: SESSION, kyoku: undefined, label: '半荘全体' };
    await stack.run(makaCommand(fakeApi(log), async () => undefined, { ...edit, before: undefined, after: 'A+' }));
    await stack.undo();
    await stack.run(makaCommand(fakeApi(log), async () => undefined, { ...edit, before: 'A+', after: undefined }));
    await stack.undo();
    expect(log).toEqual([
      `setMakaHanchan ${SESSION} A+`,
      `clearMakaHanchan ${SESSION}`,
      `clearMakaHanchan ${SESSION}`,
      `setMakaHanchan ${SESSION} A+`,
    ]);
  });

  it('通知の文: 「東1局の MAKA を S+ にしました」「…の入力を消しました」「…を元に戻しました」', () => {
    const set = makaCommand(fakeApi([]), async () => undefined, { sessionId: SESSION, kyoku: 'k0h0', label: '東1局', before: undefined, after: 'S+' });
    expect(set.label).toBe('MAKA の評価の入力');
    expect(set.messages).toEqual({
      run: '東1局の MAKA を S+ にしました',
      undo: '東1局の MAKA を元に戻しました',
      redo: '東1局の MAKA を S+ にしました',
    });
    const clear = makaCommand(fakeApi([]), async () => undefined, { sessionId: SESSION, kyoku: undefined, label: '半荘全体', before: 'A+', after: undefined });
    expect(clear.messages?.run).toBe('半荘全体の MAKA の入力を消しました');
  });
});

describe('U-11 編集のたびに半荘の一覧を読み直す（画面に反映する）', () => {
  it('実行・取り消し・やり直しの、保存のあとに reload を呼ぶ（保存が先）', async () => {
    const order: string[] = [];
    const api = fakeApi(order);
    const reload = async () => void order.push('reload');
    const stack = new UndoStack();
    await stack.run(selfRatingCommand(api, reload, { sessionId: SESSION, kyoku: 'k0h0', label: '東1局', before: undefined, after: 'bad' }));
    await stack.undo();
    await stack.redo();
    expect(order).toEqual([
      `setSelfRating ${SESSION} k0h0 bad`,
      'reload',
      `clearSelfRating ${SESSION} k0h0`,
      'reload',
      `setSelfRating ${SESSION} k0h0 bad`,
      'reload',
    ]);
  });
});
