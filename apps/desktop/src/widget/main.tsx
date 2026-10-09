import '@fontsource/ibm-plex-mono/latin-500.css';
import '../styles/tokens.css';
import '../styles/native.css';
import '../styles/error-screen.css';
import '../styles/widget.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from '../shared/ErrorBoundary';
import { installNativeBehavior } from '../shared/nativeBehavior';
import { initTheme } from '../shared/theme';
import { WidgetApp } from './WidgetApp';

initTheme();
installNativeBehavior();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary compact>
        <WidgetApp />
      </ErrorBoundary>
    </StrictMode>,
  );
}
