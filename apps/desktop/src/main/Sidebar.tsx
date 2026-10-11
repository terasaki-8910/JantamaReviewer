import { useEffect, useRef, type ReactNode } from 'react';

import appIcon from '../../src-tauri/icons/128x128.png';
import type { ThemeChoice } from '../shared/theme';
import { Icon, type IconName } from './Icon';
import type { View } from './views';

/**
 * サイドバー（U-8、U-22、R7-1、R9-9、R10-5）。固定幅（640px 未満では、アイコンだけの細い列）。
 * 上から: 見出し（左にアプリのアイコン、右に枠の無い検索のアイコンと、そのすぐ右の ← →（見た画面の履歴）。細い列では、
 * アイコン・検索・← → の順に縦に並べる）・主な操作「検討結果を取り込む」・行き先（今日の出題・解き直し。数つき。ログ・
 * 週の集計はまだ作っていないので、押せない）・半荘の一覧（`children`）・設定とテーマの切り替え。
 */

/** まだ作っていない行き先。押せない（aria-disabled）が、キーボードで止まれて、理由が読める。 */
const COMING_SOON: ReadonlyArray<{ label: string; icon: IconName }> = [
  { label: 'ログ', icon: 'log' },
  { label: '週の集計', icon: 'chart' },
];

interface SidebarProps {
  /** いま本文に出している画面。 */
  view: View;
  theme: ThemeChoice;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** 検索の重ね表示が開いているか（検索のアイコンの aria-expanded）。 */
  searchOpen: boolean;
  /** 検索の重ね表示を開く。`opener` は、閉じたときにキーボードの位置を戻す先（押したアイコン）。 */
  onSearch: (opener: HTMLElement) => void;
  onImport: () => void;
  onSettings: () => void;
  onToggleTheme: () => void;
  /** 今日の出題の、まだ答えていない問題の数。読み込み中は null（数を出さない）。 */
  todayCount: number | null;
  /** 解き直しの、今日が期限の問題の数。読み込み中は null。 */
  dueCount: number | null;
  onToday: () => void;
  onReview: () => void;
  /** 半荘の一覧。 */
  children: ReactNode;
}

/** この画面が、サイドバーのどの行き先に当たるか。 */
function destinationOf(view: View): 'today' | 'review' | null {
  if (view.kind === 'today') return 'today';
  if (view.kind === 'review') return 'review';
  if (view.kind === 'quiz') return view.mode === 'review' ? 'review' : 'today';
  return null;
}

export function Sidebar({
  view,
  theme,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  searchOpen,
  onSearch,
  onImport,
  onSettings,
  onToggleTheme,
  todayCount,
  dueCount,
  onToday,
  onReview,
  children,
}: SidebarProps) {
  const here = destinationOf(view);
  const themeLabel = theme === 'dark' ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え';
  const backRef = useRef<HTMLButtonElement>(null);
  const forwardRef = useRef<HTMLButtonElement>(null);
  // 押した ← → が、端に着いて押せなくなったとき、キーボードの位置が消えてしまわないように、移す先を決める。
  const pressed = useRef<'back' | 'forward' | null>(null);
  useEffect(() => {
    const which = pressed.current;
    if (which === null) return;
    pressed.current = null;
    const button = which === 'back' ? backRef.current : forwardRef.current;
    if (button === null || !button.disabled) return;
    const other = which === 'back' ? forwardRef.current : backRef.current;
    const fallback =
      other !== null && !other.disabled
        ? other
        : document.querySelector<HTMLElement>('.sessions [aria-current="true"]');
    fallback?.focus();
  });
  return (
    <aside className="side" aria-label="サイドバー">
      <div className="side-in">
        <div className="side-head">
          <img className="app-mark" src={appIcon} width={30} height={30} alt="JantamaReviewer" draggable={false} />
          <div className="side-tools">
            <button
              type="button"
              className="icon-btn search-btn"
              aria-label="検索"
              title="検索（Ctrl+K）"
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              aria-keyshortcuts="Control+K"
              onClick={(event) => onSearch(event.currentTarget)}
            >
              <Icon name="search" />
            </button>
            <div className="side-hist" role="group" aria-label="画面の履歴">
              <button
                type="button"
                className="icon-btn hist-btn"
                aria-label="戻る"
                title="戻る（Alt+←）"
                aria-keyshortcuts="Alt+ArrowLeft"
                ref={backRef}
                disabled={!canGoBack}
                onClick={() => {
                  pressed.current = 'back';
                  onGoBack();
                }}
              >
                <Icon name="arrowLeft" />
              </button>
              <button
                type="button"
                className="icon-btn hist-btn"
                aria-label="進む"
                title="進む（Alt+→）"
                aria-keyshortcuts="Alt+ArrowRight"
                ref={forwardRef}
                disabled={!canGoForward}
                onClick={() => {
                  pressed.current = 'forward';
                  onGoForward();
                }}
              >
                <Icon name="arrowRight" />
              </button>
            </div>
          </div>
        </div>
        <div className="side-top">
          <button
            type="button"
            className="btn primary import"
            aria-current={view.kind === 'import' ? 'page' : undefined}
            title="検討結果を取り込む"
            onClick={onImport}
          >
            <Icon name="download" />
            <span className="label">検討結果を取り込む</span>
          </button>
          <nav aria-label="メイン">
            <ul className="nav">
              <li>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={here === 'today' ? 'page' : undefined}
                  title="今日の出題"
                  onClick={onToday}
                >
                  <Icon name="today" />
                  <span className="label">今日の出題</span>
                  {todayCount !== null && (
                    <>
                      {' '}
                      <span className="count">{todayCount}</span>
                    </>
                  )}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={here === 'review' ? 'page' : undefined}
                  title="解き直し"
                  onClick={onReview}
                >
                  <Icon name="review" />
                  <span className="label">解き直し</span>
                  {dueCount !== null && (
                    <>
                      {' '}
                      <span className="count">{dueCount}</span>
                    </>
                  )}
                </button>
              </li>
              {COMING_SOON.map((item) => (
                <li key={item.label}>
                  <button type="button" className="nav-item" aria-disabled="true" title="あとで作ります">
                    <Icon name={item.icon} />
                    <span className="label">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {children}
        <div className="side-foot">
          <button
            type="button"
            className="nav-item"
            aria-current={view.kind === 'settings' ? 'page' : undefined}
            title="設定"
            onClick={onSettings}
          >
            <Icon name="settings" />
            <span className="label">設定</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={onToggleTheme}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      </div>
    </aside>
  );
}
