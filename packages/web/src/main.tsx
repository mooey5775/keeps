import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/libre-baskerville/latin-400.css';
import '@fontsource/libre-baskerville/latin-400-italic.css';
import '@fontsource/libre-baskerville/latin-700.css';
import { startSessionReplay } from './analytics.ts';
import { App } from './App.tsx';
import { clientId } from './net/store.ts';
import './styles.css';

void startSessionReplay(clientId());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
