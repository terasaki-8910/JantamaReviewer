/**
 * 操作の取り消し（U-11）の React 側。`UndoProvider` が積み重ね（`UndoStack`）を 1 つ持ち、画面のどこからでも
 * `useUndo()` で命令を登録できる（次の機能が、迷いマークの結びつけ・評価の付け直し・MAKA の入力などを足す）。
 *
 * キー: Ctrl+Z で取り消し、Ctrl+Y（と Ctrl+Shift+Z）でやり直す。文字を打つ欄（input・textarea・select・
 * contenteditable）にキーボードの位置があるときは、アプリの取り消しは動かさない（欄が自分の取り消しを持っているため）。
 * メニューや確認のダイアログが開いている間も動かさない（`useUndoBlocker`）。
 */
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';

import { UndoStack, type UndoCommand, type UndoEvent } from './undoStack';

export interface UndoApi {
  /** 命令を実行して積む（失敗したら例外。積まない）。 */
  run(command: UndoCommand): Promise<void>;
  undo(): Promise<UndoCommand | null>;
  redo(): Promise<UndoCommand | null>;
  canUndo: boolean;
  canRedo: boolean;
}

interface UndoContextValue {
  api: UndoApi;
  stack: UndoStack;
  /** キーの取り消しを止める印の数。0 より大きい間は、Ctrl+Z・Ctrl+Y を拾わない。 */
  blockersRef: RefObject<number>;
}

const UndoContext = createContext<UndoContextValue | null>(null);

/** 文字を打つ欄か（その欄が、自分の取り消しを持っている）。 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color', 'range'].includes(
      target.type,
    );
  }
  return target.isContentEditable;
}

/** キーの押し方が、取り消し・やり直しのどちらかを返す（どちらでもなければ null）。 */
export function undoActionOfKey(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !event.shiftKey) return 'redo';
  return null;
}

interface UndoProviderProps {
  children: ReactNode;
  /** 試験用: 用意した積み重ねを使う。無ければ、中で作る。 */
  stack?: UndoStack;
}

export function UndoProvider({ children, stack: given }: UndoProviderProps) {
  const [owned] = useState(() => new UndoStack());
  const stack = given ?? owned;
  const blockersRef = useRef(0);
  const canUndo = useSyncExternalStore(stack.subscribe, () => stack.canUndo);
  const canRedo = useSyncExternalStore(stack.subscribe, () => stack.canRedo);

  const actions = useMemo(
    () => ({
      run: (command: UndoCommand) => stack.run(command),
      undo: () => stack.undo(),
      redo: () => stack.redo(),
    }),
    [stack],
  );
  const api = useMemo<UndoApi>(() => ({ ...actions, canUndo, canRedo }), [actions, canUndo, canRedo]);

  const value = useMemo<UndoContextValue>(() => ({ api, stack, blockersRef }), [api, stack, blockersRef]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || blockersRef.current > 0) return;
    const action = undoActionOfKey(event);
    if (action === null || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    // 失敗は、積み重ねの知らせ（'failed'）で画面に出る。ここでは握りつぶす。
    void (action === 'undo' ? stack.undo() : stack.redo()).catch(() => undefined);
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

function useUndoContext(): UndoContextValue {
  const value = useContext(UndoContext);
  if (value === null) throw new Error('UndoProvider の中で使ってください');
  return value;
}

/** 命令を登録し、取り消し・やり直しを呼ぶ。 */
export function useUndo(): UndoApi {
  return useUndoContext().api;
}

/** 実行・取り消し・やり直し・失敗の知らせを受ける（通知を出すために使う）。 */
export function useUndoEvents(handler: (event: UndoEvent) => void): void {
  const { stack } = useUndoContext();
  const onEvent = useEffectEvent(handler);
  useEffect(() => stack.onEvent((event) => onEvent(event)), [stack]);
}

/** `active` の間、Ctrl+Z・Ctrl+Y を拾わない（メニューや確認のダイアログが開いている間）。 */
export function useUndoBlocker(active: boolean): void {
  const { blockersRef } = useUndoContext();
  useEffect(() => {
    if (!active) return undefined;
    blockersRef.current += 1;
    return () => {
      blockersRef.current -= 1;
    };
  }, [active, blockersRef]);
}
