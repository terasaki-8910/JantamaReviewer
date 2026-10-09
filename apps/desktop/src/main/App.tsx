import { useCallback, useEffect, useState } from 'react';

import { applyTheme, effectiveTheme, storeTheme, type ThemeChoice } from '../shared/theme';
import { reportBackground, signalWindowReady } from '../shared/windowReady';
import { Icon } from './Icon';
import { RecordsPage } from './RecordsPage';
import { SettingsPage } from './SettingsPage';
import { resolveView, START_VIEW, type View } from './views';

/**
 * 検討画面（メインの窓）。承認済みのシェル: 左に固定幅のサイドバー（幅 640px 未満ではアイコンだけの細い列）、
 * 下に設定とテーマの切り替え。今ある行き先（記録・設定）だけを置き、未完成の機能の項目は置かない。
 */
export function App() {
  // どの画面を見ているかは、メモリの中だけで持つ（URL のパスや履歴は使わない）。知らない名前は最初の画面。
  const [view, setView] = useState<View>(START_VIEW);
  const [theme, setTheme] = useState<ThemeChoice>(effectiveTheme);
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
          <nav aria-label="メイン">
            <ul className="nav">
              <li>
                <NavButton
                  label="記録"
                  icon="log"
                  current={view === 'records'}
                  onClick={() => show('records')}
                />
              </li>
            </ul>
          </nav>
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
      <main className="main">{view === 'records' ? <RecordsPage /> : <SettingsPage />}</main>
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
