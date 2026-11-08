// Kirajzolási hiba esetén üres oldal helyett a hibaüzenet és egy Újratöltés gomb; a hiba a szerver naplójába is bekerül.
import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info: string }> {
  state = { error: null as Error | null, info: '' };
  static getDerivedStateFromError(error: Error) {
    return { error, info: '' };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const comp = (info.componentStack || '').split('\n').filter(Boolean).slice(0, 6).join('\n');
    this.setState({ info: comp });
    try {
      fetch('/api/client-error', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cashflow' },
        body: JSON.stringify({
          message: String(error?.message || error).slice(0, 500),
          stack: String(error?.stack || '').slice(0, 1500),
          component: comp,
          url: location.hash,
        }),
      }).catch(() => null);
    } catch {
      /* nem baj */
    }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ maxWidth: 760, margin: '60px auto', padding: 24, font: '15px/1.5 Inter, system-ui, sans-serif', color: '#14233A' }}>
        <h1 style={{ font: '700 24px Georgia, serif', margin: '0 0 10px' }}>Hiba történt az oldal megjelenítésekor</h1>
        <p style={{ margin: '0 0 12px', color: '#5b6470' }}>A hibát rögzítettük. Próbáld újratölteni; ha megmarad, a fenti menüből válassz másik oldalt.</p>
        <pre
          id="cf-error"
          style={{ whiteSpace: 'pre-wrap', background: '#FAEDE9', color: '#A3392A', padding: 12, borderRadius: 8, font: '12.5px ui-monospace, monospace' }}
        >
          {String(this.state.error.message)}
          {'\n'}
          {this.state.info}
        </pre>
        <button
          type="button"
          onClick={() => ((location.hash = '#/tasks'), location.reload())}
          style={{
            marginRight: 8,
            border: 0,
            borderRadius: 999,
            background: '#1F4E79',
            color: '#fff',
            padding: '10px 20px',
            font: '600 14px Inter, sans-serif',
            cursor: 'pointer',
          }}
        >
          Ugrás a Feladatokra
        </button>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{
            border: '1px solid #ccc',
            borderRadius: 999,
            background: '#fff',
            padding: '10px 20px',
            font: '600 14px Inter, sans-serif',
            cursor: 'pointer',
          }}
        >
          Újratöltés
        </button>
      </div>
    );
  }
}
