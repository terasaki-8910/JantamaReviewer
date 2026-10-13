import { useEffect, useRef, type ReactNode, type Ref } from 'react';

import appIcon from '../../src-tauri/icons/128x128.png';
import { ariaModShortcut, historyShortcut, modShortcut } from '../shared/platform';
import type { ThemeChoice } from '../shared/theme';
import { Icon } from './Icon';
import type { View } from './views';

/**
 * サイドバー（U-8、U-22、U-32、R7-1、R9-9、R10-5、R11-15）。固定幅。640px 未満では隠れ、左上のボタンで、引き出しとして重ねて開く
 * （出す・しまう・開く・閉じるは、useSidebar.ts と App.tsx）。広い窓でも、同じボタンでしまえる。
 * 上から: 見出し（左にサイドバーを閉じるボタンとアプリのアイコン、右に枠の無い検索のアイコンと、そのすぐ右の ← →（見た画面の履歴））・
 * 主な操作「検討結果を取り込む」・行き先（今日の出題・解き直し。数つき。ログ。週の集計）・
 * 半荘の一覧（`children`）・設定とテーマの切り替え。
 */

/** 見出しの右の組（検索のアイコンと、見た画面の履歴の ← →）の部品。サイドバーの見出しと、本文の上の帯が、同じものを使う。 */
export interface HeaderToolsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** 検索の重ね表示が開いているか（検索のアイコンの aria-expanded）。 */
  searchOpen: boolean;
  /** 検索の重ね表示を開く。`opener` は、閉じたときにキーボードの位置を戻す先（押したアイコン）。 */
  onSearch: (opener: HTMLElement) => void;
}

/** サイドバーを出す・しまう（開く・閉じる）ボタン。サイドバーの中と、本文の上の帯にある。 */
export function SidebarToggle({
  expanded,
  onClick,
  ref,
}: {
  /** いま、サイドバーが見えているか。 */
  expanded: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const label = expanded ? 'サイドバーを閉じる' : 'サイドバーを開く';
  return (
    <button
      type="button"
      className="icon-btn sb-toggle"
      ref={ref}
      aria-label={label}
      title={label}
      aria-controls="sidebar"
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Icon name={expanded ? 'panelLeftClose' : 'panelLeftOpen'} />
    </button>
  );
}

/** 検索のアイコンと、そのすぐ右の ← →（見た画面の履歴）。 */
export function HeaderTools({ canGoBack, canGoForward, onGoBack, onGoForward, searchOpen, onSearch }: HeaderToolsProps) {
  // ショートカットの表示は OS で違う（Windows は Ctrl+K・Alt+← →、macOS は Cmd+K・Cmd+[ ]）。
  const back = historyShortcut('back');
  const forward = historyShortcut('forward');
  const searchRef = useRef<HTMLButtonElement>(null);
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
    const row = document.querySelector<HTMLElement>('.sessions [aria-current="true"]');
    // 引き出しが閉じているときの一覧の行には、キーボードの位置を置けない（見えない）。そのときは、検索のアイコンへ
    const fallback = other !== null && !other.disabled ? other : row !== null && row.closest('[inert]') === null ? row : searchRef.current;
    fallback?.focus();
  });
  return (
    <div className="side-tools">
      <button
        type="button"
        className="icon-btn search-btn"
        ref={searchRef}
        aria-label="検索"
        title={`検索（${modShortcut('K')}）`}
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        aria-keyshortcuts={ariaModShortcut('K')}
        onClick={(event) => onSearch(event.currentTarget)}
      >
        <Icon name="search" />
      </button>
      <div className="side-hist" role="group" aria-label="画面の履歴">
        <button
          type="button"
          className="icon-btn hist-btn"
          aria-label="戻る"
          title={`戻る（${back.label}）`}
          aria-keyshortcuts={back.aria}
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
          title={`進む（${forward.label}）`}
          aria-keyshortcuts={forward.aria}
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
  );
}

/** 本文の上の帯（細い窓と、サイドバーをしまっているとき）: 左にサイドバーを開くボタンとアプリのアイコン、右に検索と ← →。 */
export function TopBar({
  onToggle,
  toggleRef,
  tools,
}: {
  onToggle: () => void;
  toggleRef: Ref<HTMLButtonElement>;
  tools: HeaderToolsProps;
}) {
  return (
    <header className="topbar">
      <SidebarToggle expanded={false} onClick={onToggle} ref={toggleRef} />
      <img className="app-mark" src={appIcon} width={30} height={30} alt="JantamaReviewer" draggable={false} />
      <span className="topbar-sp" />
      <HeaderTools {...tools} />
    </header>
  );
}

interface SidebarProps extends HeaderToolsProps {
  /** いま本文に出している画面。 */
  view: View;
  theme: ThemeChoice;
  /** いま、サイドバーが見えているか（広い窓なら出している間、細い窓なら引き出しが開いている間）。見えていない間は、操作できない（inert）。 */
  expanded: boolean;
  /** 引き出しとして開いているか（細い窓）。開いている間は、ダイアログとして読み上げる。 */
  drawer: boolean;
  /** サイドバーを閉じる（しまう）。 */
  onToggleSidebar: () => void;
  toggleRef: Ref<HTMLButtonElement>;
  /** サイドバーの要素。引き出しを開いたとき、キーボードの位置を最初に置く所。 */
  sideRef: Ref<HTMLElement>;
  onImport: () => void;
  onSettings: () => void;
  onToggleTheme: () => void;
  /** 今日の出題の、まだ答えていない問題の数。読み込み中は null（数を出さない）。 */
  todayCount: number | null;
  /** 解き直しの、今日が期限の問題の数。読み込み中は null。 */
  dueCount: number | null;
  onToday: () => void;
  onReview: () => void;
  onLog: () => void;
  onWeek: () => void;
  /** 半荘の一覧。 */
  children: ReactNode;
}

/** この画面が、サイドバーのどの行き先に当たるか。 */
function destinationOf(view: View): 'today' | 'review' | 'log' | 'week' | null {
  if (view.kind === 'today') return 'today';
  if (view.kind === 'review') return 'review';
  if (view.kind === 'log') return 'log';
  if (view.kind === 'week') return 'week';
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
  expanded,
  drawer,
  onToggleSidebar,
  toggleRef,
  sideRef,
  onImport,
  onSettings,
  onToggleTheme,
  todayCount,
  dueCount,
  onToday,
  onReview,
  onLog,
  onWeek,
  children,
}: SidebarProps) {
  const here = destinationOf(view);
  const themeLabel = theme === 'dark' ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え';
  return (
    <aside
      className="side"
      id="sidebar"
      aria-label="サイドバー"
      ref={sideRef}
      tabIndex={-1}
      inert={!expanded}
      role={drawer ? 'dialog' : undefined}
      aria-modal={drawer ? true : undefined}
    >
      <div className="side-in">
        <div className="side-head">
          <div className="side-id">
            <SidebarToggle expanded onClick={onToggleSidebar} ref={toggleRef} />
            <img className="app-mark" src={appIcon} width={30} height={30} alt="JantamaReviewer" draggable={false} />
          </div>
          <HeaderTools
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
            searchOpen={searchOpen}
            onSearch={onSearch}
          />
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
              <li>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={here === 'log' ? 'page' : undefined}
                  title="ログ"
                  onClick={onLog}
                >
                  <Icon name="log" />
                  <span className="label">ログ</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={here === 'week' ? 'page' : undefined}
                  title="週の集計"
                  onClick={onWeek}
                >
                  <Icon name="chart" />
                  <span className="label">週の集計</span>
                </button>
              </li>
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
