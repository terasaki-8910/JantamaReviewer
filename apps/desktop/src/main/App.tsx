import { useCallback, useEffect, useState } from 'react';

import { applyTheme, effectiveTheme, storeTheme, type ThemeChoice } from '../shared/theme';
import { Icon } from './Icon';
import { RecordsPage } from './RecordsPage';
import { SettingsPage } from './SettingsPage';

type Page = 'records' | 'settings';

/**
 * 検討画面（メインの窓）。承認済みのシェル: 左に固定幅のサイドバー（幅 640px 未満ではアイコンだけの細い列）、
 * 下に設定とテーマの切り替え。今ある行き先（記録・設定）だけを置き、未完成の機能の項目は置かない。
 */
export function App() {
  const [page, setPage] = useState<Page>('records');
  const [theme, setTheme] = useState<ThemeChoice>(effectiveTheme);

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
                  current={page === 'records'}
                  onClick={() => setPage('records')}
                />
              </li>
            </ul>
          </nav>
          <div className="side-foot">
            <NavButton
              label="設定"
              icon="settings"
              current={page === 'settings'}
              onClick={() => setPage('settings')}
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
      <main className="main">{page === 'records' ? <RecordsPage /> : <SettingsPage />}</main>
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
