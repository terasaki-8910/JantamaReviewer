import '@fontsource/ibm-plex-mono/latin-500.css';
import '../styles/tokens.css';
import '../styles/widget.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initTheme } from '../shared/theme';
import { WidgetApp } from './WidgetApp';

initTheme();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <WidgetApp />
    </StrictMode>,
  );
}
