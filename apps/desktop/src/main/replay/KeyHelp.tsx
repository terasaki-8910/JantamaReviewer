/**
 * キーの説明と割り当ての変更（F12、R10-3、U-21）。操作の段のキーボードのアイコンを押すか、マウスを乗せると、
 * すべての操作とそのキーの一覧が、アイコンのそばに重なって出る。
 *
 * - マウスを乗せると出て（離すと閉じる）、押すと出したままにする（もう一度押す・Esc・外を押す・閉じるで閉じる）。押した状態でも、
 *   マウスを乗せて出した状態でも、中の「変更」を押せる
 * - 「変更」を押すと、その操作が、次に押したキーを待つ。押したキーが、すでにほかの操作のキーなら、割り当てずに、その操作の名前を出す
 *   （入れ替えない）。Tab・Esc・Enter・Space・Alt+← →（画面の戻る・進む）・Ctrl+K（検索）・Ctrl+Z・Ctrl+Y（取り消し）は、割り当てられない。
 *   待っている間は、Esc でやめる
 * - 「外す」で、その操作をボタンだけにする。「既定に戻す」で、すべて既定のキーに戻す
 * - 変えるたびに、設定（settings.json）へ保存する。保存できなかったら、その理由を出して、キーは変えない
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { ReplayKeys } from '../../api/types';
import {
  REPLAY_ACTIONS,
  assignKey,
  chordOfEvent,
  chordParts,
  clearKey,
  defaultReplayKeys,
  type ReplayAction,
} from './keys';
import { ReplayIcon } from './ReplayIcons';

interface KeyHelpProps {
  keys: ReplayKeys;
  /** 割り当てを保存する。保存できなかったときは、その理由の文を返す（保存できたら null）。 */
  onChange: (next: ReplayKeys) => Promise<string | null>;
}

type Mode = 'closed' | 'peek' | 'pinned';

/** マウスを離してから閉じるまでの、猶予（ミリ秒）。アイコンと重なりの間を、マウスが渡れるように。 */
const LEAVE_MS = 220;

function KeyCaps({ chord }: { chord: string | null }) {
  if (chord === null) return <span className="kp-none">なし</span>;
  return (
    <span className="kp-caps" aria-label={chordParts(chord).join('+')}>
      {chordParts(chord).map((part, index) => (
        <kbd className="key-cap" key={`${index}${part}`} aria-hidden="true">
          {part}
        </kbd>
      ))}
    </span>
  );
}

export function KeyHelp({ keys, onChange }: KeyHelpProps) {
  const [mode, setMode] = useState<Mode>('closed');
  const [capturing, setCapturing] = useState<ReplayAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const changeRefs = useRef(new Map<ReplayAction, HTMLButtonElement>());
  const leaveTimer = useRef<number | null>(null);
  const panelId = useId();
  const open = mode !== 'closed';

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);

  const close = useCallback(
    (returnFocus: boolean) => {
      clearLeaveTimer();
      setMode('closed');
      setCapturing(null);
      setMessage(null);
      if (returnFocus) buttonRef.current?.focus();
    },
    [clearLeaveTimer],
  );

  useEffect(() => clearLeaveTimer, [clearLeaveTimer]);

  // アイコンのそばに置く。窓の中に収める（開く前に決める）
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const button = buttonRef.current;
    if (!open || panel === null || button === null) return;
    const rect = button.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, viewWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > viewHeight - 8) top = Math.max(8, rect.top - height - 6);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }, [open]);

  // Esc・外の押下・窓の大きさの変化で閉じる（キーを待っている間の Esc は、待つのをやめるだけ）
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || capturing !== null) return;
      event.preventDefault();
      event.stopPropagation();
      close(mode === 'pinned' || panelRef.current?.contains(document.activeElement) === true);
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, capturing, mode, close]);

  // 押した「変更」は、待っている間は「やめる」に替わって消えるので、戻ったあとの描画で、キーボードの位置を戻す
  const focusChange = useCallback((action: ReplayAction) => {
    window.setTimeout(() => changeRefs.current.get(action)?.focus(), 0);
  }, []);

  // 「変更」を押したあと、次に押したキーを割り当てる
  useEffect(() => {
    if (capturing === null) return undefined;
    const action = capturing;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        setCapturing(null);
        setMessage(null);
        focusChange(action);
        return;
      }
      if (event.repeat) return;
      const chord = chordOfEvent(event);
      if (chord === null) return; // 修飾キーだけ。組み合わせの続きを待つ
      const result = assignKey(keys, action, chord);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setMessage(null);
      setCapturing(null);
      focusChange(action);
      if (result.keys[action] === keys[action]) return;
      void onChange(result.keys).then((failure) => {
        if (failure !== null) setMessage(failure);
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, keys, onChange, focusChange]);

  const isDefault = REPLAY_ACTIONS.every((action) => keys[action.id] === action.key);

  const save = (next: ReplayKeys) => {
    setMessage(null);
    void onChange(next).then((failure) => {
      if (failure !== null) setMessage(failure);
    });
  };

  const onEnter = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    clearLeaveTimer();
    setMode((current) => (current === 'closed' ? 'peek' : current));
  };

  // マウスを離したら閉じる（押して出したものは、そのまま）。キーを待っているときは、中の「変更」を押した（出したまま）なので閉じない
  const onLeave = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    clearLeaveTimer();
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      setMode((current) => (current === 'peek' ? 'closed' : current));
    }, LEAVE_MS);
  };

  return (
    <div className="keyhelp" ref={rootRef} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button
        type="button"
        className="icon-btn key-btn"
        ref={buttonRef}
        aria-label="キーの一覧と割り当て"
        title="キーの一覧と割り当て"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => {
          clearLeaveTimer();
          if (mode === 'pinned') {
            close(false);
            return;
          }
          setMode('pinned');
          // キーボードで押したときは、出した一覧へ、キーボードの位置を移す（マウスのときは、アイコンのまま）
          if (event.detail === 0) window.setTimeout(() => panelRef.current?.focus(), 0);
        }}
      >
        <ReplayIcon name="keyboard" />
      </button>
      {open && (
        <div
          className="keypanel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="キーの一覧と割り当て"
          tabIndex={-1}
          onFocus={() => setMode((current) => (current === 'peek' ? 'pinned' : current))}
        >
          <div className="kp-head">
            <h2 className="kp-title">キー</h2>
            <button type="button" className="icon-btn kp-x" aria-label="閉じる" onClick={() => close(true)}>
              <ReplayIcon name="close" />
            </button>
          </div>
          <ul className="kp-list" aria-label="操作とキー">
            {REPLAY_ACTIONS.map((action) => {
              const waiting = capturing === action.id;
              const chord = keys[action.id] ?? null;
              return (
                <li className="kp-row" key={action.id} data-action={action.id} data-waiting={waiting ? '1' : undefined}>
                  <span className="kp-name">
                    {action.label}
                    {action.note !== undefined && <span className="kp-note">{action.note}</span>}
                  </span>
                  <span className="kp-key">
                    {waiting ? (
                      <span className="kp-wait" role="status">
                        新しいキーを押してください
                      </span>
                    ) : (
                      <KeyCaps chord={chord} />
                    )}
                  </span>
                  <span className="kp-act">
                    {waiting ? (
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`${action.label}のキーの変更をやめる`}
                        onClick={() => {
                          setCapturing(null);
                          setMessage(null);
                          focusChange(action.id);
                        }}
                      >
                        やめる
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`${action.label}のキーを変更`}
                          ref={(element) => {
                            if (element === null) changeRefs.current.delete(action.id);
                            else changeRefs.current.set(action.id, element);
                          }}
                          onClick={() => {
                            setMessage(null);
                            setCapturing(action.id);
                          }}
                        >
                          変更
                        </button>
                        {chord !== null && (
                          <button
                            type="button"
                            className="link-btn"
                            aria-label={`${action.label}のキーを外す`}
                            onClick={() => save(clearKey(keys, action.id))}
                          >
                            外す
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="kp-msg" role="alert">
            {message}
          </p>
          <div className="kp-foot">
            <button type="button" className="btn sm" disabled={isDefault} onClick={() => save(defaultReplayKeys())}>
              既定に戻す
            </button>
            <p className="quiet">変更を押して、新しいキーを押します。同じキーを 2 つの操作には割り当てられません。</p>
          </div>
        </div>
      )}
    </div>
  );
}
