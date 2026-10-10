import { useCallback, useEffect, useState } from 'react';

import { applyTheme, effectiveTheme, storeTheme, type ThemeChoice } from '../shared/theme';
import { reportBackground, signalWindowReady } from '../shared/windowReady';
import { Icon } from './Icon';
import { ImportOffer } from './ImportOffer';
import { ImportPage } from './ImportPage';
import { RecordsPage } from './RecordsPage';
import { SettingsPage } from './SettingsPage';
import { useImportFlow } from './useImportFlow';
import { resolveView, START_VIEW, type View } from './views';

/**
 * 検討画面（メインの窓）。承認済みのシェル: 左に固定幅のサイドバー（幅 640px 未満ではアイコンだけの細い列）、
 * 上に主な操作「検討結果を取り込む」、下に設定とテーマの切り替え。今ある行き先（記録・取り込み・設定）だけを置き、
 * 未完成の機能の項目は置かない。
 */
export function App() {
  // どの画面を見ているかは、メモリの中だけで持つ（URL のパスや履歴は使わない）。知らない名前は最初の画面。
  const [view, setView] = useState<View>(START_VIEW);
  const [theme, setTheme] = useState<ThemeChoice>(effectiveTheme);
  // 取り込みの状態は、画面を移っても保つ（mjai の窓からの知らせを、取りこぼさないため）。
  const flow = useImportFlow();
  // 取り込んだ半荘を、記録のページで開くときに選ぶ半荘。
  const [focusSession, setFocusSession] = useState<string | null>(null);
  const show = useCallback((name: string) => setView(resolveView(name)), []);

  // 最初の絵を描き終えたと知らせる。窓は、それまで隠れている（N-7）。
  useEffect(() => {
    void signalWindowReady();
  }, []);

  // OS のテーマが変わったとき（明示して選んでいなければ）表示を合わせる。
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setTheme(effectiveTheme());
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: ThemeChoice = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
    setTheme(next);
    void reportBackground();
  }, []);

  const { reset, acceptOffer } = flow;
  const phase = flow.state.phase;
  const openImport = useCallback(() => {
    // 別のページから来たときは、取り込みの続き（途中・完了・失敗）をそのまま見せる（別のページにいる間に終わっても、
    // 結果を見逃さない）。取り込みのページを開いたまま押したときは、終わった取り込みを閉じて、新しく始める。
    if (view === 'import' && (phase === 'done' || phase === 'error')) reset();
    show('import');
  }, [phase, reset, show, view]);
  const acceptImportOffer = useCallback(() => {
    acceptOffer();
    show('import');
  }, [acceptOffer, show]);
  const openRecords = useCallback(() => {
    setFocusSession(null);
    show('records');
  }, [show]);
  const openSession = useCallback(
    (sessionId: string) => {
      // 終わった取り込みの結果は、半荘を開いたら閉じる（次に取り込みを開いたとき、古い結果が残らないように）。
      reset();
      setFocusSession(sessionId);
      show('records');
    },
    [reset, show],
  );

  const themeLabel = theme === 'dark' ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え';

  return (
    <div className="app">
      <aside className="side" aria-label="サイドバー">
        <div className="side-in">
          <div className="brand">
            <span className="full">JantamaReviewer</span>
            <span className="short" aria-hidden="true">
              雀
            </span>
          </div>
          <div className="side-top">
            <button
              type="button"
              className="btn primary import"
              aria-current={view === 'import' ? 'page' : undefined}
              title="検討結果を取り込む"
              onClick={openImport}
            >
              <Icon name="download" />
              <span className="label">検討結果を取り込む</span>
            </button>
            <nav aria-label="メイン">
              <ul className="nav">
                <li>
                  <NavButton
                    label="記録"
                    icon="log"
                    current={view === 'records'}
                    onClick={() => openRecords()}
                  />
                </li>
              </ul>
            </nav>
          </div>
          <div className="side-foot">
            <NavButton
              label="設定"
              icon="settings"
              current={view === 'settings'}
              onClick={() => show('settings')}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={themeLabel}
              title={themeLabel}
              onClick={toggleTheme}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        {flow.offer && view !== 'import' && (
          <ImportOffer link={flow.offer} onAccept={acceptImportOffer} onDismiss={flow.dismissOffer} />
        )}
        {view === 'records' && <RecordsPage focusSessionId={focusSession} />}
        {view === 'settings' && <SettingsPage />}
        {view === 'import' && <ImportPage flow={flow} onOpenSession={openSession} />}
      </main>
    </div>
  );
}

interface NavButtonProps {
  label: string;
  icon: 'log' | 'settings';
  current: boolean;
  onClick: () => void;
}

function NavButton({ label, icon, current, onClick }: NavButtonProps) {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={current ? 'page' : undefined}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="label">{label}</span>
    </button>
  );
}
