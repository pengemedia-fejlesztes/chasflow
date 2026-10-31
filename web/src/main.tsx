import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
