/**
 * 半荘を通して見る画面（F12）のキーの割り当て（R10-3、U-21）。純粋な関数と表だけ（画面にも Tauri にも依存しない）。
 *
 * 既定（R10-3 の答えと、そのときの案どおり）:
 *   , .        1手戻る・1手進む（全員の打牌と鳴きを 1 つずつ）
 *   ← →        前・次の自分の判断（鳴きを含む）
 *   ↑ ↓        前・次の不一致
 *   Shift+↑ ↓  前・次の迷い
 *   Shift+← →  前・次の局
 * 巡目の移動・局の頭・局の終わりは、ボタンだけ（キーは割り当てで足せる）。
 *
 * キーは、`KeyboardEvent.code` に、押していた修飾キーを `Ctrl+` `Alt+` `Shift+` の順に付けた文字（例: `Shift+ArrowUp`・`Comma`）。
 * 配列によらず、同じ位置のキーが同じ意味になる。設定ファイルの `replay_keys`（settings.rs。同じ表と同じ検査を持つ。試験が突き合わせる）に保存する。
 * 割り当てられない: Tab・Esc・Enter・Space（画面の操作）、Alt+← →（画面の戻る・進む）、Ctrl+K（検索）、Ctrl+Z・Ctrl+Y（取り消し）。
 * 同じキーを 2 つの操作には割り当てられない（黙って入れ替えない。どの操作が使っているかを、理由に書いて断る）。
 */
import type { ReplayKeys } from '../../api/types';

export type ReplayAction =
  | 'step_back'
  | 'step_forward'
  | 'prev_decision'
  | 'next_decision'
  | 'prev_mismatch'
  | 'next_mismatch'
  | 'prev_doubt'
  | 'next_doubt'
  | 'prev_kyoku'
  | 'next_kyoku'
  | 'prev_turn'
  | 'next_turn'
  | 'kyoku_start'
  | 'kyoku_end';

export interface ReplayActionDef {
  id: ReplayAction;
  /** 画面に出す操作の名前。 */
  label: string;
  /** 補足（名前だけでは分かりにくいものだけ）。 */
  note?: string;
  /** 既定のキー。無ければ null（ボタンだけ）。 */
  key: string | null;
}

/** 操作の一覧（キーの説明に出す順。settings.rs の `ACTIONS` と同じ名前・同じ既定）。 */
export const REPLAY_ACTIONS: readonly ReplayActionDef[] = [
  { id: 'step_back', label: '1手戻る', note: '全員の打牌と鳴きを 1 つずつ', key: 'Comma' },
  { id: 'step_forward', label: '1手進む', note: '全員の打牌と鳴きを 1 つずつ', key: 'Period' },
  { id: 'prev_decision', label: '前の自分の判断', note: '鳴きを含む', key: 'ArrowLeft' },
  { id: 'next_decision', label: '次の自分の判断', note: '鳴きを含む', key: 'ArrowRight' },
  { id: 'prev_mismatch', label: '前の不一致', key: 'ArrowUp' },
  { id: 'next_mismatch', label: '次の不一致', key: 'ArrowDown' },
  { id: 'prev_doubt', label: '前の迷い', key: 'Shift+ArrowUp' },
  { id: 'next_doubt', label: '次の迷い', key: 'Shift+ArrowDown' },
  { id: 'prev_kyoku', label: '前の局', key: 'Shift+ArrowLeft' },
  { id: 'next_kyoku', label: '次の局', key: 'Shift+ArrowRight' },
  { id: 'prev_turn', label: '前の巡目', key: null },
  { id: 'next_turn', label: '次の巡目', key: null },
  { id: 'kyoku_start', label: '局の頭', key: null },
  { id: 'kyoku_end', label: '局の終わり', key: null },
];

const ACTION_BY_ID = new Map<string, ReplayActionDef>(REPLAY_ACTIONS.map((action) => [action.id, action]));

export function actionLabel(id: ReplayAction): string {
  return ACTION_BY_ID.get(id)?.label ?? id;
}

/** 既定の割り当て。 */
export function defaultReplayKeys(): ReplayKeys {
  return Object.fromEntries(REPLAY_ACTIONS.map((action) => [action.id, action.key]));
}

/** 設定の値（足りない操作・読めない値があってもよい）を、すべての操作が入った割り当てにする。足りない操作は既定のキー。 */
export function normalizeReplayKeys(raw: unknown): ReplayKeys {
  const keys = defaultReplayKeys();
  if (typeof raw !== 'object' || raw === null) return keys;
  const given = raw as Record<string, unknown>;
  for (const action of REPLAY_ACTIONS) {
    const value = given[action.id];
    if (value === null) keys[action.id] = null;
    else if (typeof value === 'string') keys[action.id] = value;
  }
  return keys;
}

// ---- キーの書き方 ----

/** 修飾キーそのものの `KeyboardEvent.code`（単独では、割り当てにしない）。 */
const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)$|^AltGraph$/;

/** 画面の操作に使うので、割り当てられないキー（修飾キーが付いていても）。 */
const RESERVED_CODES: ReadonlySet<string> = new Set(['Tab', 'Escape', 'Enter', 'NumpadEnter', 'Space']);

const PUNCTUATION_CODES: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Comma',
  'Period',
  'Slash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Minus',
  'Equal',
  'Backquote',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** 割り当てに使えるキーか（英字・数字・矢印・記号・Home/End/PageUp/PageDown。settings.rs と同じ）。 */
function isUsableCode(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || PUNCTUATION_CODES.has(code);
}

interface ChordParts {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

function splitChord(chord: string): ChordParts | null {
  const parts = chord.trim().split('+');
  const code = parts.pop();
  if (code === undefined || code === '') return null;
  const seen = { ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    const flag = part === 'Ctrl' ? 'ctrl' : part === 'Alt' ? 'alt' : part === 'Shift' ? 'shift' : null;
    if (flag === null || seen[flag]) return null;
    seen[flag] = true;
  }
  return { ...seen, code };
}

function joinChord({ ctrl, alt, shift, code }: ChordParts): string {
  return `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${code}`;
}

/** 押したキー（修飾キー単独は null。Win キーが付いているものも null）を、割り当ての書き方にする。 */
export function chordOfEvent(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string | null {
  if (event.code === '' || event.code === 'Unidentified' || MODIFIER_CODE.test(event.code) || event.metaKey) return null;
  return joinChord({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, code: event.code });
}

export type ChordCheck = { kind: 'ok' } | { kind: 'reserved' } | { kind: 'unusable' };

/**
 * 割り当てられる入力か。
 * - reserved: 画面の操作（Tab・Esc・Enter・Space）、画面の戻る・進む（Alt+← →）、検索（Ctrl+K）、取り消しとやり直し（Ctrl+Z・Ctrl+Y）
 * - unusable: 使えないキー（F キー・Win キー・かな変換のキーなど）
 */
export function checkChord(chord: string): ChordCheck {
  const parts = splitChord(chord);
  if (parts === null) return { kind: 'unusable' };
  const { ctrl, alt, shift, code } = parts;
  if (RESERVED_CODES.has(code)) return { kind: 'reserved' };
  if (ctrl && (code === 'KeyK' || code === 'KeyZ' || code === 'KeyY')) return { kind: 'reserved' };
  if (alt && !ctrl && !shift && (code === 'ArrowLeft' || code === 'ArrowRight')) return { kind: 'reserved' };
  return isUsableCode(code) ? { kind: 'ok' } : { kind: 'unusable' };
}

// ---- 割り当ての変更 ----

export type AssignResult =
  | { ok: true; keys: ReplayKeys }
  | { ok: false; reason: 'reserved' | 'unusable' | 'duplicate'; message: string; other?: ReplayAction };

/** そのキーを割り当てている操作（無ければ null）。`except` の操作は数えない。 */
export function actionOfChord(keys: ReplayKeys, chord: string, except?: ReplayAction): ReplayAction | null {
  for (const action of REPLAY_ACTIONS) {
    if (action.id !== except && keys[action.id] === chord) return action.id;
  }
  return null;
}

/**
 * 操作にキーを割り当てる。割り当てられない入力・ほかの操作がすでに使っているキーは、割り当てずに、理由を返す
 * （入れ替えない。どの操作が使っているかを、理由に書く）。同じ操作に、いまと同じキーを割り当てるのは、何も変わらずに成功。
 */
export function assignKey(keys: ReplayKeys, action: ReplayAction, chord: string): AssignResult {
  const checked = checkChord(chord);
  const shown = formatChord(chord);
  if (checked.kind === 'reserved') {
    return {
      ok: false,
      reason: 'reserved',
      message: `${shown} は、画面の操作・戻る・進む・検索・取り消しに使うので、割り当てられません。`,
    };
  }
  if (checked.kind === 'unusable') {
    return { ok: false, reason: 'unusable', message: `${shown} は、割り当てられないキーです。` };
  }
  const other = actionOfChord(keys, chord, action);
  if (other !== null) {
    return {
      ok: false,
      reason: 'duplicate',
      other,
      message: `${shown} は、すでに「${actionLabel(other)}」に使っています。先に「${actionLabel(other)}」のキーを変えてください。`,
    };
  }
  return { ok: true, keys: { ...keys, [action]: chord } };
}

/** 操作のキーを外す（ボタンだけにする）。 */
export function clearKey(keys: ReplayKeys, action: ReplayAction): ReplayKeys {
  return { ...keys, [action]: null };
}

// ---- 画面に出す書き方 ----

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

/** キー 1 つ（`KeyboardEvent.code`）の画面の書き方。例: ArrowUp → ↑、KeyJ → J、Digit1 → 1、Comma → ,。 */
export function keyName(code: string): string {
  const named = KEY_NAMES[code];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1] ?? code;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1] ?? code;
  return code;
}

/** 割り当ての、画面の書き方を、キーごとに分けたもの（`<kbd>` に 1 つずつ入れる）。例: Shift+ArrowUp → ['Shift', '↑']。 */
export function chordParts(chord: string): string[] {
  const parts = splitChord(chord);
  if (parts === null) return [chord];
  const out: string[] = [];
  if (parts.ctrl) out.push('Ctrl');
  if (parts.alt) out.push('Alt');
  if (parts.shift) out.push('Shift');
  out.push(keyName(parts.code));
  return out;
}

/** 読み上げ用のキーの名前（記号は、読み上げで抜けることがあるので、言葉にする）。 */
const SPOKEN_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: '上矢印',
  ArrowDown: '下矢印',
  ArrowLeft: '左矢印',
  ArrowRight: '右矢印',
  Comma: 'カンマ',
  Period: 'ピリオド',
  Slash: 'スラッシュ',
  Semicolon: 'セミコロン',
  Quote: 'シングルクォート',
  BracketLeft: '左角かっこ',
  BracketRight: '右角かっこ',
  Backslash: 'バックスラッシュ',
  Minus: 'マイナス',
  Equal: 'イコール',
  Backquote: 'バッククォート',
};

/** 読み上げ用の書き方。例: Shift+ArrowUp → Shift+上矢印、Comma → カンマ。割り当て無しは「なし」。 */
export function spokenChord(chord: string | null): string {
  if (chord === null) return 'なし';
  const parts = splitChord(chord);
  if (parts === null) return chord;
  const out: string[] = [];
  if (parts.ctrl) out.push('Ctrl');
  if (parts.alt) out.push('Alt');
  if (parts.shift) out.push('Shift');
  out.push(SPOKEN_NAMES[parts.code] ?? keyName(parts.code));
  return out.join('+');
}

/** 1 つの文字にした書き方。例: Shift+↑。割り当て無しは「なし」。 */
export function formatChord(chord: string | null): string {
  return chord === null ? 'なし' : chordParts(chord).join('+');
}
