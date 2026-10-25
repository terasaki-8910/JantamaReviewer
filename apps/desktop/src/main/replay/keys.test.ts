import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REPLAY_ACTIONS,
  actionOfChord,
  assignKey,
  checkChord,
  chordOfEvent,
  chordParts,
  clearKey,
  defaultReplayKeys,
  formatChord,
  keyName,
  normalizeReplayKeys,
  spokenChord,
} from './keys';

const event = (code: string, init: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: init.ctrl ?? false,
  altKey: init.alt ?? false,
  shiftKey: init.shift ?? false,
  metaKey: init.meta ?? false,
});

describe('U-21 通して見る画面のキーの既定（R10-3、R11-4）', () => {
  it('U-21 既定のキー: , . で 1 手、← → で自分の判断、↑ ↓ で悪手、Shift+↑ ↓ で迷い、Shift+← → で局、Home・End で局の頭・局の終わり。巡目はボタンだけ', () => {
    const keys = defaultReplayKeys();
    expect(keys).toEqual({
      step_back: 'Comma',
      step_forward: 'Period',
      prev_decision: 'ArrowLeft',
      next_decision: 'ArrowRight',
      prev_mismatch: 'ArrowUp',
      next_mismatch: 'ArrowDown',
      prev_doubt: 'Shift+ArrowUp',
      next_doubt: 'Shift+ArrowDown',
      prev_kyoku: 'Shift+ArrowLeft',
      next_kyoku: 'Shift+ArrowRight',
      prev_turn: null,
      next_turn: null,
      kyoku_start: 'Home',
      kyoku_end: 'End',
    });
  });

  it('U-21 既定どうしで、同じキーが 2 つの操作に付いていない。既定はすべて、割り当てられるキー', () => {
    const keys = defaultReplayKeys();
    const assigned = Object.values(keys).filter((key): key is string => key !== null);
    expect(new Set(assigned).size).toBe(assigned.length);
    for (const key of assigned) expect(checkChord(key)).toEqual({ kind: 'ok' });
  });

  it('U-21 操作の表（名前・既定）は、設定ファイルの側（settings の replay_keys.rs）の表と同じ', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../src-tauri/src/replay_keys.rs'), 'utf8');
    const block = /pub const ACTIONS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source)?.[1] ?? '';
    const rows = [...block.matchAll(/\("([a-z_]+)",\s*(?:Some\("([A-Za-z+]+)"\)|None)\)/g)].map(
      (match) => [match[1], match[2] ?? null] as const,
    );
    expect(rows).toEqual(REPLAY_ACTIONS.map((action) => [action.id, action.key]));
  });

  it('U-21 割り当てられない入力の表も、設定ファイルの側と同じ決まり（Tab・Esc・Enter・Space・Alt+← →・Ctrl+K・Ctrl+Z・Ctrl+Y）', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../src-tauri/src/replay_keys.rs'), 'utf8');
    expect(source).toContain('["Tab", "Escape", "Enter", "NumpadEnter", "Space"]');
    expect(source).toContain('"KeyK" | "KeyZ" | "KeyY"');
    expect(source).toContain('"ArrowLeft" | "ArrowRight"');
  });
});

describe('U-21 押したキーを割り当ての書き方にする', () => {
  it('U-21 KeyboardEvent.code に、押していた修飾キーを Ctrl+ Alt+ Shift+ の順に付ける', () => {
    expect(chordOfEvent(event('Comma'))).toBe('Comma');
    expect(chordOfEvent(event('ArrowUp', { shift: true }))).toBe('Shift+ArrowUp');
    expect(chordOfEvent(event('KeyJ', { shift: true, ctrl: true }))).toBe('Ctrl+Shift+KeyJ');
    expect(chordOfEvent(event('KeyJ', { shift: true, ctrl: true, alt: true }))).toBe('Ctrl+Alt+Shift+KeyJ');
  });

  it('U-21 修飾キーだけ・Win キーが付いたもの・読み取れないキーは、割り当ての対象にならない（null）', () => {
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'OSLeft', 'AltGraph', 'Unidentified', '']) {
      expect(chordOfEvent(event(code)), code).toBeNull();
    }
    expect(chordOfEvent(event('KeyJ', { meta: true }))).toBeNull();
  });

  it('U-21 画面に出す書き方: ArrowUp は ↑、KeyJ は J、Comma は , 。修飾キーは + でつなぐ。割り当て無しは「なし」', () => {
    expect(keyName('ArrowLeft')).toBe('←');
    expect(keyName('KeyJ')).toBe('J');
    expect(keyName('Digit3')).toBe('3');
    expect(keyName('Comma')).toBe(',');
    expect(keyName('Period')).toBe('.');
    expect(keyName('PageUp')).toBe('PageUp');
    expect(chordParts('Shift+ArrowUp')).toEqual(['Shift', '↑']);
    expect(chordParts('Ctrl+Alt+Shift+KeyJ')).toEqual(['Ctrl', 'Alt', 'Shift', 'J']);
    expect(formatChord('Shift+ArrowUp')).toBe('Shift+↑');
    expect(formatChord('Period')).toBe('.');
    expect(formatChord(null)).toBe('なし');
  });

  it('U-21 読み上げ用の書き方: 矢印や記号は言葉にする（アクセシブルな名前に使う）。割り当て無しは「なし」', () => {
    expect(spokenChord('ArrowUp')).toBe('上矢印');
    expect(spokenChord('Shift+ArrowLeft')).toBe('Shift+左矢印');
    expect(spokenChord('Comma')).toBe('カンマ');
    expect(spokenChord('Period')).toBe('ピリオド');
    expect(spokenChord('Ctrl+Alt+Shift+KeyJ')).toBe('Ctrl+Alt+Shift+J');
    expect(spokenChord('Digit3')).toBe('3');
    expect(spokenChord(null)).toBe('なし');
    // 設定のどの既定のキーも、読み上げ用の名前に記号が残らない
    for (const chord of Object.values(defaultReplayKeys())) {
      if (chord !== null) expect(spokenChord(chord)).not.toMatch(/[←→↑↓,.]/);
    }
  });
});

describe('U-21 キーの割り当ての変更: 同じキーを別の操作には割り当てない', () => {
  it('U-21 使っていないキーは割り当てられる。いまと同じキーを同じ操作に割り当てても、何も変わらずに成功する', () => {
    const keys = defaultReplayKeys();
    const result = assignKey(keys, 'step_back', 'KeyJ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keys.step_back).toBe('KeyJ');
      expect(result.keys.step_forward).toBe('Period');
    }
    const same = assignKey(keys, 'step_back', 'Comma');
    expect(same).toEqual({ ok: true, keys });
    // 巡目の移動にも、キーを足せる
    const turn = assignKey(keys, 'next_turn', 'Shift+Period');
    expect(turn.ok && turn.keys.next_turn).toBe('Shift+Period');
  });

  it('U-21 ほかの操作が使っているキーは、割り当てずに、どの操作が使っているかを理由に書いて断る（入れ替えない）', () => {
    const keys = defaultReplayKeys();
    const result = assignKey(keys, 'prev_turn', 'ArrowRight');
    expect(result).toEqual({
      ok: false,
      reason: 'duplicate',
      other: 'next_decision',
      message: '→ は、すでに「次の自分の判断」に使っています。先に「次の自分の判断」のキーを変えてください。',
    });
    const withShift = assignKey(keys, 'prev_turn', 'Shift+ArrowUp');
    expect(!withShift.ok && withShift.other).toBe('prev_doubt');
    expect(!withShift.ok && withShift.message).toContain('「前の迷い」');
    // 変えていないので、割り当ては元のまま
    expect(keys.prev_turn).toBeNull();
    expect(keys.next_decision).toBe('ArrowRight');
  });

  it('U-21 割り当てられない入力（Tab・Esc・Enter・Space・Alt+← →・Ctrl+K・Ctrl+Z・Ctrl+Y）は、理由を書いて断る', () => {
    const keys = defaultReplayKeys();
    for (const reserved of ['Tab', 'Shift+Tab', 'Escape', 'Enter', 'Space', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Ctrl+KeyK', 'Ctrl+KeyZ', 'Ctrl+KeyY', 'Ctrl+Shift+KeyZ']) {
      const result = assignKey(keys, 'prev_turn', reserved);
      expect(result.ok, reserved).toBe(false);
      expect(!result.ok && result.reason, reserved).toBe('reserved');
      expect(!result.ok && result.message, reserved).toContain('割り当てられません');
    }
    // F キー・ひらがなの変換のキーなどは、使えないキー
    for (const unusable of ['F5', 'F12', 'Convert', 'KanaMode', 'Numpad1', 'Shift+Insert']) {
      const result = assignKey(keys, 'prev_turn', unusable);
      expect(!result.ok && result.reason, unusable).toBe('unusable');
    }
    // ← や Ctrl+← は割り当てられる（Alt+← だけが画面の戻る・進む）
    expect(assignKey(keys, 'prev_turn', 'Ctrl+ArrowLeft').ok).toBe(true);
    expect(assignKey(keys, 'prev_turn', 'Ctrl+Alt+ArrowLeft').ok).toBe(true);
  });

  it('U-21 キーを外すと、その操作はボタンだけになる。外したキーは、別の操作に割り当てられる', () => {
    const cleared = clearKey(defaultReplayKeys(), 'step_back');
    expect(cleared.step_back).toBeNull();
    expect(actionOfChord(cleared, 'Comma')).toBeNull();
    const result = assignKey(cleared, 'prev_turn', 'Comma');
    expect(result.ok && result.keys.prev_turn).toBe('Comma');
  });

  it('U-21 キーから操作を引く（自分自身は数えない）', () => {
    const keys = defaultReplayKeys();
    expect(actionOfChord(keys, 'Shift+ArrowDown')).toBe('next_doubt');
    expect(actionOfChord(keys, 'KeyZ')).toBeNull();
    expect(actionOfChord(keys, 'Comma', 'step_back')).toBeNull();
  });
});

describe('U-21 設定の値を割り当てにする', () => {
  it('U-21 足りない操作は既定のキー。null は割り当て無し。読めない値は既定のキーのまま', () => {
    const keys = normalizeReplayKeys({ step_back: 'KeyJ', prev_decision: null, step_forward: 5 });
    expect(keys.step_back).toBe('KeyJ');
    expect(keys.prev_decision).toBeNull();
    expect(keys.step_forward).toBe('Period');
    expect(keys.next_kyoku).toBe('Shift+ArrowRight');
    expect(Object.keys(keys)).toHaveLength(REPLAY_ACTIONS.length);
    expect(normalizeReplayKeys(undefined)).toEqual(defaultReplayKeys());
    expect(normalizeReplayKeys('Comma')).toEqual(defaultReplayKeys());
  });

  it('U-21 Home・End: 保存してある設定にこの 2 つの操作の値が無ければ、既定の Home・End が入る。書いてあるキーは守る', () => {
    const keys = normalizeReplayKeys({ step_back: 'KeyJ', next_turn: 'KeyL' });
    expect(keys.kyoku_start).toBe('Home');
    expect(keys.kyoku_end).toBe('End');
    expect(keys.step_back).toBe('KeyJ');
    expect(keys.next_turn).toBe('KeyL');
    expect(Object.keys(keys)).toEqual(REPLAY_ACTIONS.map((action) => action.id));
  });

  it('U-21 Home・End: 利用者が外した操作（null）は、外れたまま。別のキーに替えたものも、そのまま', () => {
    const cleared = normalizeReplayKeys({ ...defaultReplayKeys(), kyoku_start: null });
    expect(cleared.kyoku_start).toBeNull();
    expect(cleared.kyoku_end).toBe('End');
    const changed = normalizeReplayKeys({ ...defaultReplayKeys(), kyoku_start: 'KeyH', kyoku_end: null });
    expect(changed.kyoku_start).toBe('KeyH');
    expect(changed.kyoku_end).toBeNull();
  });

  it('U-21 Home・End: ほかの操作がすでに Home か End を使っていれば、局の頭・局の終わりは割り当て無し（重なりを作らない）', () => {
    const keys = normalizeReplayKeys({ prev_turn: 'Home', step_back: 'KeyJ' });
    expect(keys.prev_turn).toBe('Home');
    expect(keys.kyoku_start).toBeNull();
    expect(keys.kyoku_end).toBe('End');
    expect(keys.step_back).toBe('KeyJ');
    const both = normalizeReplayKeys({ prev_turn: 'Home', next_turn: 'End' });
    expect(both.kyoku_start).toBeNull();
    expect(both.kyoku_end).toBeNull();
    for (const result of [keys, both]) {
      const assigned = Object.values(result).filter((key): key is string => key !== null);
      expect(new Set(assigned).size).toBe(assigned.length);
    }
  });

  it('U-21 Home・End は、割り当ての操作で、ほかの操作が使っていれば断る（局の頭に End は付けられない）', () => {
    const keys = defaultReplayKeys();
    const refused = assignKey(keys, 'kyoku_start', 'End');
    expect(refused).toMatchObject({ ok: false, reason: 'duplicate', other: 'kyoku_end' });
    expect(assignKey(keys, 'prev_turn', 'Home')).toMatchObject({ ok: false, reason: 'duplicate', other: 'kyoku_start' });
    expect(checkChord('Home')).toEqual({ kind: 'ok' });
    expect(checkChord('End')).toEqual({ kind: 'ok' });
    expect(formatChord('Home')).toBe('Home');
    expect(spokenChord('End')).toBe('End');
  });
});
