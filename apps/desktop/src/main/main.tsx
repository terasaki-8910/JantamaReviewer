import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/zen-old-mincho/latin-700.css';
import '../styles/tokens.css';
import '../styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initTheme } from '../shared/theme';
import { App } from './App';

initTheme();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
