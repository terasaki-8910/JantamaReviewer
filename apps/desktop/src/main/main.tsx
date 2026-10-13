import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/zen-old-mincho/latin-700.css';
import '../styles/tokens.css';
import '../styles/native.css';
import '../styles/error-screen.css';
import '../styles/app.css';
import '../styles/sessions.css';
import '../styles/hanchan.css';
import '../styles/quiz.css';
import '../styles/yaku.css';
import '../styles/waits.css';
import '../styles/replay.css';
import '../styles/search.css';
import '../styles/log.css';
import '../styles/week.css';
import '../styles/export.css';
import '../styles/sync.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from '../shared/ErrorBoundary';
import { installNativeBehavior } from '../shared/nativeBehavior';
import { loadPlatform } from '../shared/platform';
import { initTheme } from '../shared/theme';
import { App } from './App';

initTheme();
installNativeBehavior();

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  // 最初の絵を描く前に、OS の名前と使える機能を受け取る（設定ページの行・ショートカットの表示を、最初から合わせるため）。
  // 受け取れなくても、Windows として描く。
  void loadPlatform().then(() => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  });
}
