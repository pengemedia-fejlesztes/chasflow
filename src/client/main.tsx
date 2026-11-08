import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

// Alkonyvtarban futtatas (pl. /Cashflow): az abszolut /api hivasokat az alap-utvonal ala tesszuk.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
if (BASE) {
  const eredeti = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) return eredeti(BASE + input, init);
    return eredeti(input as RequestInfo, init);
  };
}

// élesítés után a régi, nyitva maradt lap a már nem létező részfájlt kérné (pl. Fedezeti pont / XLS): egyszer újratöltjük
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('cf-reload') || 0);
    if (Date.now() - last < 30000) return;
    sessionStorage.setItem('cf-reload', String(Date.now()));
  } catch {
    /* privát mód */
  }
  e.preventDefault();
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
