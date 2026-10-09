// Belépési folyamat (első admin, bejelentkezés, 2FA, kötelező jelszócsere) és a reszponzív elrendezés választása.
import { useCallback, useEffect, useState } from 'react';
import type { DataBundle, Me } from '../../shared/types';
import { api } from './api';
import { Desktop, logout } from './Desktop';
import { Mobile } from './Mobile';
import { StoreProvider } from './store';
import { C, FONT, FONT_H, inputStyle } from './ui';

function useIsMobile() {
  const q = '(max-width: 900px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

let mailOn = false;

type Phase =
  | { k: 'loading' }
  | { k: 'login'; setup: boolean }
  | { k: 'reset'; token: string }
  | { k: 'changePw'; me: Me }
  | { k: 'app'; data: DataBundle }
  | { k: 'error'; msg: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const mobile = useIsMobile();

  const boot = useCallback(async () => {
    try {
      const resetToken = new URLSearchParams(location.search).get('reset');
      if (resetToken) {
        // a token ne maradjon a címsorban / előzményekben
        history.replaceState(null, '', location.pathname);
        return setPhase({ k: 'reset', token: resetToken });
      }
      const s = await api<{ hasUsers: boolean; setupAvailable: boolean; mailEnabled: boolean; me: Me | null }>('/api/auth/status');
      mailOn = s.mailEnabled;
      if (!s.me) return setPhase({ k: 'login', setup: !s.hasUsers && s.setupAvailable });
      if (s.me.must_change_pw) return setPhase({ k: 'changePw', me: s.me });
      setPhase({ k: 'app', data: await api<DataBundle>('/api/data') });
    } catch (e: any) {
      setPhase({ k: 'error', msg: e.message });
    }
  }, []);

  useEffect(() => {
    boot();
    const h = () => setPhase({ k: 'login', setup: false });
    window.addEventListener('cf-logout', h);
    return () => window.removeEventListener('cf-logout', h);
  }, [boot]);

  const doLogout = async () => {
    await logout();
    setPhase({ k: 'login', setup: false });
  };

  if (phase.k === 'loading') return <Splash>Betöltés…</Splash>;
  if (phase.k === 'error')
    return (
      <Splash>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <span>{phase.msg}</span>
          <button onClick={boot} style={btn}>
            Újra
          </button>
        </div>
      </Splash>
    );
  if (phase.k === 'login') return <Login setup={phase.setup} onDone={boot} />;
  if (phase.k === 'reset') return <ResetPw token={phase.token} onDone={() => setPhase({ k: 'login', setup: false })} />;
  if (phase.k === 'changePw') return <ChangePw me={phase.me} onDone={boot} onLogout={doLogout} />;
  return <StoreProvider initial={phase.data}>{mobile ? <Mobile onLogout={doLogout} /> : <Desktop onLogout={doLogout} />}</StoreProvider>;
}

const btn: React.CSSProperties = {
  height: 48,
  border: 0,
  borderRadius: 999,
  background: C.blue,
  color: '#fff',
  font: `600 15px ${FONT}`,
  cursor: 'pointer',
  padding: '0 22px',
};

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: C.navy,
        color: '#fff',
        font: `500 15px ${FONT}`,
        padding: 20,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: C.navy, padding: '24px 16px' }}>
      <div style={{ width: 'min(400px, 100%)', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, color: '#fff' }}>
          <div style={{ width: 40, height: 40, borderRadius: 999, background: C.blue, display: 'grid', placeItems: 'center', font: `800 12px ${FONT_H}` }}>
            CF
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
            <span style={{ font: `700 19px ${FONT_H}` }}>
              Cashflow <b style={{ color: C.blue2 }}>tervező</b>
            </span>
            <span style={{ font: `600 10px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted2 }}>360 Marketing</span>
          </div>
        </div>
        <div style={{ background: '#fff', borderRadius: 20, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ font: `700 20px ${FONT_H}`, color: C.navy }}>{title}</div>
            {sub && <div style={{ font: `400 13.5px/1.5 ${FONT}`, color: C.muted, marginTop: 6 }}>{sub}</div>}
          </div>
          {children}
        </div>
        <span style={{ font: `400 12px ${FONT}`, color: C.muted2, textAlign: 'center' }}>Védett, csak meghívott felhasználóknak.</span>
      </div>
    </div>
  );
}

const big: React.CSSProperties = { ...inputStyle, height: 48, fontSize: 16, borderRadius: 12 };

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [f, setF] = useState({ email: '', password: '', totp: '', token: '', name: '' });
  const [needTotp, setNeedTotp] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [info, setInfo] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (forgot) {
        const r = await api<{ message: string }>('/api/auth/forgot', { body: { email: f.email } });
        setInfo(r.message);
      } else if (setup) {
        await api('/api/auth/setup', { body: { token: f.token, email: f.email, name: f.name, password: f.password } });
        onDone();
      } else {
        const r = await api<{ needTotp?: boolean }>('/api/auth/login', { body: { email: f.email, password: f.password, totp: needTotp ? f.totp : undefined } });
        if (r.needTotp) setNeedTotp(true);
        else onDone();
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title={setup ? 'Első adminisztrátor létrehozása' : forgot ? 'Elfelejtett jelszó' : 'Bejelentkezés'}
      sub={
        setup
          ? 'Add meg a telepítéskor beállított beállító kódot (SETUP_TOKEN).'
          : forgot
            ? 'Add meg az e-mail címed, és küldünk egy linket, amellyel új jelszót állíthatsz be (30 percig érvényes).'
            : undefined
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {setup && (
          <input required placeholder="Beállító kód" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} style={big} autoComplete="off" />
        )}
        {setup && <input required placeholder="Név" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={big} autoComplete="name" />}
        {!needTotp && (
          <>
            <input
              required
              type="email"
              placeholder="E-mail"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
              style={big}
              autoComplete="username"
              autoCapitalize="none"
            />
            {!forgot && (
              <input
                required
                type="password"
                placeholder={setup ? 'Jelszó (min. 12 karakter)' : 'Jelszó'}
                value={f.password}
                onChange={(e) => setF({ ...f, password: e.target.value })}
                style={big}
                autoComplete={setup ? 'new-password' : 'current-password'}
              />
            )}
          </>
        )}
        {needTotp && (
          <input
            autoFocus
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 jegyű kód a hitelesítő alkalmazásból"
            value={f.totp}
            onChange={(e) => setF({ ...f, totp: e.target.value })}
            style={big}
          />
        )}
        {err && <span style={{ font: `500 13.5px ${FONT}`, color: C.neg }}>{err}</span>}
        {info && <span style={{ font: `500 13.5px/1.5 ${FONT}`, color: C.blueDark }}>{info}</span>}
        {!info && (
          <button type="submit" disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
            {busy ? '…' : setup ? 'Létrehozás' : forgot ? 'Link küldése' : needTotp ? 'Ellenőrzés' : 'Belépés'}
          </button>
        )}
        {!setup && !needTotp && (
          <button
            type="button"
            onClick={() => {
              setForgot(!forgot);
              setErr('');
              setInfo('');
            }}
            style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 13.5px ${FONT}`, cursor: 'pointer', padding: 6 }}
          >
            {forgot ? '← Vissza a belépéshez' : mailOn ? 'Elfelejtett jelszó?' : 'Elfelejtett jelszó? Kérd az adminisztrátort.'}
          </button>
        )}
      </form>
    </Shell>
  );
}

function ChangePw({ me, onDone, onLogout }: { me: Me; onDone: () => void; onLogout: () => void }) {
  const [f, setF] = useState({ current: '', next: '', next2: '' });
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.next2) return setErr('A két jelszó nem egyezik.');
    try {
      await api('/api/account/password', { body: { current: f.current, next: f.next } });
      onDone();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Shell title="Új jelszó beállítása" sub={`Szia ${me.name}! Az ideiglenes jelszót most le kell cserélned (min. 12 karakter).`}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input type="email" value={me.email} readOnly autoComplete="username" style={{ ...big, background: C.bg }} />
        <input
          required
          type="password"
          placeholder="Ideiglenes jelszó"
          value={f.current}
          onChange={(e) => setF({ ...f, current: e.target.value })}
          style={big}
          autoComplete="current-password"
        />
        <input
          required
          type="password"
          placeholder="Új jelszó"
          value={f.next}
          onChange={(e) => setF({ ...f, next: e.target.value })}
          style={big}
          autoComplete="new-password"
        />
        <input
          required
          type="password"
          placeholder="Új jelszó újra"
          value={f.next2}
          onChange={(e) => setF({ ...f, next2: e.target.value })}
          style={big}
          autoComplete="new-password"
        />
        {err && <span style={{ font: `500 13.5px ${FONT}`, color: C.neg }}>{err}</span>}
        <button type="submit" style={btn}>
          Mentés
        </button>
        <button type="button" onClick={onLogout} style={{ ...btn, background: 'transparent', color: C.blueDark }}>
          Kilépés
        </button>
      </form>
    </Shell>
  );
}

function ResetPw({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<{ valid: boolean; needTotp?: boolean; email?: string } | null>(null);
  const [f, setF] = useState({ next: '', next2: '', totp: '' });
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    api<{ valid: boolean; needTotp?: boolean; email?: string }>('/api/auth/reset-info', { body: { token } }).then(setState, () => setState({ valid: false }));
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (f.next !== f.next2) return setErr('A két jelszó nem egyezik.');
    try {
      await api('/api/auth/reset', { body: { token, password: f.next, totp: f.totp } });
      setDone(true);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  if (!state) return <Splash>Ellenőrzés…</Splash>;
  if (!state.valid || done)
    return (
      <Shell
        title={done ? 'Jelszó megváltoztatva ✓' : 'A link lejárt'}
        sub={
          done
            ? 'Most már beléphetsz az új jelszavaddal. Biztonsági okból minden eszközön kiléptettünk.'
            : 'A visszaállító link 30 percig érvényes és csak egyszer használható. Kérj újat a belépő oldalon.'
        }
      >
        <button onClick={onDone} style={btn}>
          Tovább a belépéshez
        </button>
      </Shell>
    );
  return (
    <Shell title="Új jelszó beállítása" sub="Legalább 12 karakter. Használj jelszókezelőt (pl. iCloud Kulcskarika).">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input type="email" value={state.email || ''} readOnly autoComplete="username" style={{ ...big, background: C.bg }} />
        <input
          required
          type="password"
          placeholder="Új jelszó"
          value={f.next}
          onChange={(e) => setF({ ...f, next: e.target.value })}
          style={big}
          autoComplete="new-password"
        />
        <input
          required
          type="password"
          placeholder="Új jelszó újra"
          value={f.next2}
          onChange={(e) => setF({ ...f, next2: e.target.value })}
          style={big}
          autoComplete="new-password"
        />
        {state.needTotp && (
          <input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 jegyű kód a hitelesítő alkalmazásból"
            value={f.totp}
            onChange={(e) => setF({ ...f, totp: e.target.value })}
            style={big}
          />
        )}
        {err && <span style={{ font: `500 13.5px ${FONT}`, color: C.neg }}>{err}</span>}
        <button type="submit" style={btn}>
          Jelszó mentése
        </button>
      </form>
    </Shell>
  );
}
