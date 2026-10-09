// Beállítások: saját fiók (jelszó, 2FA), felhasználók, integrációk (Billingo, bankok), adatok (import, nyitó egyenleg), kategóriák.
import { useEffect, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { parseBankRows } from '../../shared/bankfile';
import { fmt } from '../../shared/model';
import { api } from './api';
import { RulesTab } from './RulesTab';
import { APP_BUILD, APP_COMMIT, APP_VERSION } from './version';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, LeafSelect, Pill, Seg, card, eyebrow, inputStyle, relTime } from './ui';

type Tab = 'account' | 'users' | 'integrations' | 'data' | 'categories' | 'rules';

export function SettingsView({ onLogout, mobile }: { onLogout: () => void; mobile?: boolean }) {
  const { isAdmin } = useStore();
  const [tab, setTab] = useState<Tab>('account');
  const tabs: [Tab, string][] = [['account', 'Fiókom']];
  if (isAdmin) tabs.push(['users', 'Felhasználók'], ['integrations', 'Bekötések'], ['data', 'Adatok']);
  tabs.push(['rules', 'Párosítások'], ['categories', 'Kategóriák']);
  return (
    <div style={{ padding: mobile ? '14px 16px 120px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 980 }}>
      {!mobile && <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Beállítások</h1>}
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
        Verzió: <b style={{ color: C.navy }}>{APP_VERSION}</b> · élesítve: {APP_BUILD} · {APP_COMMIT}
      </span>
      <div style={{ overflowX: 'auto' }}>
        <Seg value={tab} onChange={setTab} options={tabs} />
      </div>
      {tab === 'account' && <Account onLogout={onLogout} />}
      {tab === 'users' && isAdmin && <Users />}
      {tab === 'integrations' && isAdmin && <Integrations />}
      {tab === 'data' && isAdmin && <DataTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'categories' && <Categories />}
    </div>
  );
}

function Section({ title, children, sub }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>{title}</div>
        {sub && <div style={{ font: `400 13.5px/1.5 ${FONT}`, color: C.muted, marginTop: 4 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Account({ onLogout }: { onLogout: () => void }) {
  const { data, run, showToast } = useStore();
  const [pw, setPw] = useState({ current: '', next: '', next2: '' });
  const [totp, setTotp] = useState<{ secret: string; url: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [dpw, setDpw] = useState('');

  const changePw = async () => {
    if (pw.next !== pw.next2) return showToast({ msg: 'A két új jelszó nem egyezik.', error: true });
    if (await run(() => api('/api/account/password', { body: { current: pw.current, next: pw.next } }), 'Jelszó megváltoztatva'))
      setPw({ current: '', next: '', next2: '' });
  };
  const startTotp = async () => {
    try {
      const r = await api<{ secret: string; url: string }>('/api/account/totp/setup', { body: {} });
      const QR = await import('qrcode');
      setTotp({ ...r, qr: await QR.toDataURL(r.url, { margin: 1, width: 200 }) });
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };
  return (
    <>
      <Section
        title={data.me.name}
        sub={`${data.me.email} · szerepkör: ${{ admin: 'adminisztrátor', member: 'szerkesztő', viewer: 'csak olvasó' }[data.me.role]}`}
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Pill onClick={onLogout}>Kilépés</Pill>
          <Pill
            kind="danger"
            onClick={() => confirm('Minden eszközön kiléptetünk (ezen is). Folytatod?') && api('/api/account/sessions', { method: 'DELETE' }).then(onLogout)}
          >
            Kilépés minden eszközön
          </Pill>
        </div>
      </Section>
      <Section title="Jelszó módosítása" sub="Legalább 12 karakter. Használj jelszókezelőt (pl. iCloud Kulcskarika).">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Jelenlegi jelszó"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
            style={inputStyle}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Új jelszó"
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
            style={inputStyle}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Új jelszó újra"
            value={pw.next2}
            onChange={(e) => setPw({ ...pw, next2: e.target.value })}
            style={inputStyle}
          />
        </div>
        <div>
          <Pill kind="dark" onClick={changePw}>
            Jelszó mentése
          </Pill>
        </div>
      </Section>
      <Section
        title="Kétlépcsős azonosítás (2FA)"
        sub="Erősen ajánlott: belépéskor a jelszó mellett egy 6 jegyű kódot is kér a telefonos hitelesítő alkalmazásból (pl. Google Authenticator, Microsoft Authenticator, iPhone Jelszavak)."
      >
        {data.me.totp_enabled ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ font: `600 14px ${FONT}`, color: C.blueDark }}>✓ Bekapcsolva</span>
            <input
              type="password"
              placeholder="Jelszó a kikapcsoláshoz"
              value={dpw}
              onChange={(e) => setDpw(e.target.value)}
              style={{ ...inputStyle, width: 220 }}
            />
            <Pill kind="danger" onClick={() => run(() => api('/api/account/totp/disable', { body: { password: dpw } }), '2FA kikapcsolva')}>
              Kikapcsolás
            </Pill>
          </div>
        ) : totp ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <img src={totp.qr} width={180} height={180} alt="2FA QR kód" style={{ borderRadius: 10, border: `1px solid ${C.line}` }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 220, flex: 1 }}>
              <span style={{ font: `400 13.5px/1.5 ${FONT}`, color: C.muted }}>
                Olvasd be a QR kódot (iPhone-on: koppints rá hosszan, vagy add meg kézzel a kulcsot):
                <br />
                <code style={{ font: `600 13px ui-monospace,monospace`, color: C.navy, wordBreak: 'break-all' }}>{totp.secret}</code>
              </span>
              <a href={totp.url} style={{ font: `600 13px ${FONT}` }}>
                Megnyitás hitelesítő alkalmazásban (telefonon)
              </a>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6 jegyű kód"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  style={{ ...inputStyle, width: 140 }}
                />
                <Pill
                  kind="dark"
                  onClick={() => run(() => api('/api/account/totp/enable', { body: { code } }), '2FA bekapcsolva ✓').then((ok) => ok && setTotp(null))}
                >
                  Bekapcsolás
                </Pill>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <Pill kind="primary" onClick={startTotp}>
              2FA beállítása
            </Pill>
          </div>
        )}
      </Section>
    </>
  );
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  totp_enabled: number;
  disabled: number;
  last_login: number | null;
}

function Users() {
  const { data, showToast } = useStore();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [nu, setNu] = useState({ email: '', name: '', role: 'member' });
  const [temp, setTemp] = useState<{ email: string; pw: string } | null>(null);
  const load = () => api<UserRow[]>('/api/users').then(setUsers, (e) => showToast({ msg: e.message, error: true }));
  useEffect(() => {
    load();
  }, []);
  const act = async (fn: () => Promise<any>) => {
    try {
      const r = await fn();
      await load();
      return r;
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };
  return (
    <>
      <Section
        title="Új felhasználó"
        sub="Ideiglenes jelszót kap, amit első belépéskor meg kell változtatnia. Az adatokhoz csak a meghívott felhasználók férnek hozzá."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
          <input placeholder="E-mail" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} style={inputStyle} />
          <input placeholder="Név" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} style={inputStyle} />
          <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })} style={inputStyle}>
            <option value="admin">Adminisztrátor</option>
            <option value="member">Szerkesztő</option>
            <option value="viewer">Csak olvasó</option>
          </select>
          <Pill
            kind="dark"
            onClick={async () => {
              const r = await act(() => api('/api/users', { body: nu }));
              if (r?.tempPassword) {
                setTemp({ email: nu.email, pw: r.tempPassword });
                setNu({ email: '', name: '', role: 'member' });
              }
            }}
          >
            Hozzáadás
          </Pill>
        </div>
        {temp && (
          <div style={{ background: C.bg2, borderRadius: 10, padding: 14, font: `500 14px/1.5 ${FONT}`, color: C.navy }}>
            Ideiglenes jelszó ({temp.email}): <b style={{ fontFamily: 'ui-monospace,monospace', userSelect: 'all' }}>{temp.pw}</b>
            <br />
            <span style={{ color: C.muted, fontSize: 12.5 }}>
              Csak most látható. Biztonságos csatornán add át (pl. személyesen / Signal), és kérd meg, hogy kapcsolja be a 2FA-t.
            </span>
          </div>
        )}
      </Section>
      <Section title="Felhasználók">
        {users.map((u) => (
          <div
            key={u.id}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
              borderTop: `1px solid ${C.line3}`,
              paddingTop: 10,
              opacity: u.disabled ? 0.55 : 1,
            }}
          >
            <span style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column' }}>
              <span style={{ font: `600 14px ${FONT}`, color: C.navy }}>
                {u.name} {u.id === data.me.id && <span style={{ color: C.muted, fontWeight: 500 }}>(te)</span>}
              </span>
              <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                {u.email} · 2FA: {u.totp_enabled ? 'be' : 'ki'} · utolsó belépés: {u.last_login ? relTime(u.last_login) : 'még nem'}
              </span>
            </span>
            <select
              value={u.role}
              disabled={u.id === data.me.id}
              onChange={(e) => act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }))}
              style={{ ...inputStyle, height: 34 }}
            >
              <option value="admin">Adminisztrátor</option>
              <option value="member">Szerkesztő</option>
              <option value="viewer">Csak olvasó</option>
            </select>
            {u.id !== data.me.id && (
              <>
                <Pill
                  small
                  onClick={async () => {
                    if (!confirm(`Új ideiglenes jelszó ${u.email} részére? (A 2FA is törlődik.)`)) return;
                    const r = await act(() => api(`/api/users/${u.id}/reset`, { body: {} }));
                    if (r?.tempPassword) setTemp({ email: u.email, pw: r.tempPassword });
                  }}
                >
                  Jelszó reset
                </Pill>
                <Pill small onClick={() => act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }))}>
                  {u.disabled ? 'Engedélyez' : 'Letilt'}
                </Pill>
                <Pill small kind="danger" onClick={() => confirm(`Törlöd: ${u.email}?`) && act(() => api(`/api/users/${u.id}`, { method: 'DELETE' }))}>
                  Törlés
                </Pill>
              </>
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

function Integrations() {
  const { data, ix, run, showToast } = useStore();
  const [aspsps, setAspsps] = useState<{ name: string; psu_types?: string[] }[] | null>(null);
  const [bank, setBank] = useState('');
  const [psu, setPsu] = useState<'business' | 'personal'>('business');
  const [csv, setCsv] = useState({ bank: 'BiNX', label: 'Üzleti számla', balance: '' }); // a bank a fájlból felismerve felülíródik

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('bank')) {
      showToast(p.get('bank') === 'ok' ? 'Bankszámla összekapcsolva ✓' : { msg: 'Bankkapcsolat hiba: ' + (p.get('msg') || ''), error: true });
      history.replaceState(null, '', location.pathname);
    }
  }, []);

  const loadAspsps = async () => {
    try {
      const r = await api<{ name: string; psu_types?: string[] }[]>('/api/bank/aspsps');
      setAspsps(r);
      const pref = r.find((a) => /binx/i.test(a.name)) || r.find((a) => /magnet/i.test(a.name));
      if (pref) setBank(pref.name);
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };
  const connect = async () => {
    try {
      const r = await api<{ url: string }>('/api/bank/connect', { body: { bank_name: bank, psu_type: psu } });
      location.href = r.url;
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };
  const importCsv = async (file: File) => {
    const XLSX = await import('xlsx');
    let wb;
    if (/\.(csv|txt)$/i.test(file.name)) {
      // magyar netbank exportok: gyakran pontosvessző elválasztó, néha Windows-1250 kódolás
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('windows-1250').decode(buf);
      const first = text.split(/\r?\n/)[0] || '';
      const FS = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
      wb = XLSX.read(text, { type: 'string', FS, raw: true });
    } else wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, raw: false });
    const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    let parsed;
    try {
      parsed = parseBankRows(rows, file.name);
    } catch (e: any) {
      return showToast({ msg: e.message, error: true });
    }
    if (!parsed.rows.length) return showToast({ msg: 'Nem találtam tételeket.', error: true });
    const bankName = parsed.bank || csv.bank;
    const label = csv.label || 'Üzleti számla';
    let balance: string | null = csv.balance.trim() || null;
    const summary = `${bankName} · ${label}\n${parsed.rows.length} tétel (${parsed.from} – ${parsed.to})${parsed.skipped ? `, ${parsed.skipped} kihagyva (nem teljesült / üres)` : ''}\nA tételek összege: ${fmt(parsed.sum)} Ft`;
    if (!confirm(summary + '\n\nBeolvassam? A korábbi (a TÉNYEK-ben már szereplő) időszak tételei csak archívumba kerülnek, jóváhagyásra csak az újak jönnek.'))
      return;
    if (
      !balance &&
      confirm(
        `Ha ez a kivonat a számla NYITÁSÁTÓL indul, akkor a mai egyenleg ${fmt(parsed.sum)} Ft.\n\nBeállítsam ezt a számla egyenlegének? (Mégse = később kézzel adod meg)`,
      )
    )
      balance = String(parsed.sum);
    const out = parsed.rows;
    let res: any = null;
    await run(async () => {
      res = await api('/api/bank/import', { body: { bank_name: bankName, label, balance, rows: out } });
    });
    if (res)
      showToast(
        `${bankName}: ${res.inbox} új tétel jóváhagyásra, ${res.auto || 0} automatikusan könyvelve, ${res.archived} archívumba (≤ ${res.cutoff || '—'}), ${res.duplicates} már korábban beolvasva.`,
      );
  };

  return (
    <>
      <Section
        title="Billingo"
        sub="A kiállított számlák (Billingo v3 API) óránként szinkronizálódnak: a nyitott számlák tervezett bevételként jelennek meg a fizetési határidőn. Az API kulcsot titokként kell beállítani (BILLINGO_API_KEY) – lásd README."
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ font: `600 14px ${FONT}`, color: data.integrations.billingo ? C.blueDark : C.neg }}>
            {data.integrations.billingo ? '✓ API kulcs beállítva' : '✗ Nincs API kulcs'}
          </span>
          <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>utolsó szinkron: {relTime(data.settings.billingo_last_sync)}</span>
          {data.integrations.billingo && <Pill onClick={() => run(() => api('/api/sync', { body: {} }), 'Szinkron kész')}>↻ Szinkron most</Pill>}
        </div>
        <Field label="Alapértelmezett kategória ismeretlen partnernél (üres = új alkategória a Projektek alatt)">
          <LeafSelect
            ix={ix}
            section="in"
            value={data.settings.billingo_leaf_default || ''}
            onChange={(v) => run(() => api('/api/settings', { method: 'PUT', body: { billingo_leaf_default: v } }), 'Mentve')}
          />
        </Field>
      </Section>
      <Section
        title="Bankkapcsolat – PSD2 (BiNX, Magnet)"
        sub="Az Enable Banking engedélyezett számlainformációs szolgáltatón keresztül csak olvasási hozzáférést adsz (egyenleg + tételek), legfeljebb 180 napra – utána újra kell engedélyezni. A banki belépés a bank saját oldalán történik."
      >
        {!data.integrations.enableBanking ? (
          <span style={{ font: `500 14px ${FONT}`, color: C.neg }}>
            Az Enable Banking nincs beállítva (EB_APP_ID, EB_PRIVATE_KEY titkok) – lásd README. Addig használd a kivonat importot lent.
          </span>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {aspsps ? (
              <select value={bank} onChange={(e) => setBank(e.target.value)} style={{ ...inputStyle, minWidth: 240 }}>
                <option value="">Válassz bankot…</option>
                {aspsps.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <Pill onClick={loadAspsps}>Elérhető bankok betöltése</Pill>
            )}
            <Seg
              small
              value={psu}
              onChange={setPsu}
              options={[
                ['business', 'Céges'],
                ['personal', 'Magán'],
              ]}
            />
            {aspsps && (
              <Pill kind="primary" disabled={!bank} onClick={connect}>
                Összekapcsolás →
              </Pill>
            )}
          </div>
        )}
        {data.accounts.map((a) => (
          <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 10 }}>
            <span style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column' }}>
              <span style={{ font: `600 14px ${FONT}`, color: C.navy }}>
                {a.bank_name} · {a.label}
              </span>
              <span style={{ font: `400 12.5px ${FONT}`, color: a.last_error ? C.neg : C.muted }}>
                {a.provider === 'manual' ? 'kézi kivonat' : 'PSD2'} · {a.iban || ''} · egyenleg: {a.balance != null ? fmt(a.balance) + ' Ft' : '—'} ·{' '}
                {a.last_error || 'szinkron ' + relTime(a.last_sync)}
                {a.valid_until ? ' · hozzájárulás lejár: ' + a.valid_until.slice(0, 10) : ''}
              </span>
            </span>
            {a.provider === 'manual' && (
              <input
                placeholder="Aktuális egyenleg"
                inputMode="numeric"
                defaultValue={a.balance ?? ''}
                onBlur={(e) =>
                  e.target.value !== String(a.balance ?? '') &&
                  run(() => api(`/api/bank/accounts/${a.id}`, { method: 'PATCH', body: { balance: e.target.value || null } }), 'Egyenleg mentve')
                }
                style={{ ...inputStyle, width: 150, height: 34 }}
              />
            )}
            <Pill
              small
              onClick={() =>
                run(
                  () => api(`/api/bank/accounts/${a.id}`, { method: 'PATCH', body: { active: !a.active } }),
                  a.active ? 'Számla kikapcsolva' : 'Számla bekapcsolva',
                )
              }
            >
              {a.active ? 'Kikapcsol' : 'Bekapcsol'}
            </Pill>
          </div>
        ))}
      </Section>
      <Section
        title="Banki kivonat import (CSV / XLSX)"
        sub="Ha a bank nem érhető el PSD2-n, töltsd le a netbankból a számlakivonatot (CSV vagy Excel), és töltsd fel ide. A tételek a Bankszinkronba kerülnek jóváhagyásra; a duplikációkat a rendszer kiszűri."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, alignItems: 'end' }}>
          <Field label="Bank">
            <input value={csv.bank} onChange={(e) => setCsv({ ...csv, bank: e.target.value })} style={inputStyle} list="banks" />
            <datalist id="banks">
              <option value="BiNX" />
              <option value="Magnet" />
            </datalist>
          </Field>
          <Field label="Számla neve">
            <input value={csv.label} onChange={(e) => setCsv({ ...csv, label: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="Záró egyenleg (opcionális)">
            <input value={csv.balance} inputMode="numeric" onChange={(e) => setCsv({ ...csv, balance: e.target.value })} style={inputStyle} />
          </Field>
          <label
            style={{
              ...inputStyle,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              background: C.navy,
              color: '#fff',
              fontWeight: 600,
              borderRadius: 999,
            }}
          >
            Fájl kiválasztása…
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.txt"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
            />
          </label>
        </div>
      </Section>
    </>
  );
}

function DataTab() {
  const { ix, data, run, showToast } = useStore();
  const [bal, setBal] = useState('');
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState('');

  const importXls = async (file: File, kind: 'actual' | 'plan') => {
    setBusy(kind);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
      const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const hi = rows.findIndex((r) => r.some((c) => /d[aá]tum/i.test(String(c))) && r.some((c) => /kateg/i.test(String(c))));
      if (hi < 0) throw new Error('Nem találom a fejlécet (Dátum, Tétel, Kategória, Összeg).');
      const h = rows[hi].map((c) => String(c).toLowerCase());
      const ci = (re: RegExp) => h.findIndex((x) => re.test(x));
      const [cd, cn, cc, ca] = [ci(/d[aá]tum/), ci(/t[eé]tel|megnevez/), ci(/kateg/), ci(/[öo]sszeg$/)];
      const out = rows
        .slice(hi + 1)
        .map((r) => ({ date: r[cd], name: String(r[cn] ?? ''), category: String(r[cc] ?? ''), amount: Number(r[ca]) || 0 }))
        .filter((r) => r.date);
      await run(
        () => api('/api/import', { body: { kind, rows: out, replacePlans: kind === 'plan' && replace } }),
        `${out.length} sor feldolgozva (${kind === 'actual' ? 'tények' : 'tervek'})`,
      );
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Section
        title="Aktuális egyenleg (ha nincs bankkapcsolat)"
        sub={`Bankkapcsolat nélkül az egyenleg = nyitó egyenleg + összes tény. Add meg a mai valós egyenleget (a két bankszámla összegét), és a rendszer kiszámolja a nyitó egyenleget. Jelenleg: nyitó ${fmt(ix.opening)} Ft, számított mai egyenleg ${fmt(ix.computedBalance)} Ft${ix.bankBalance != null ? ', banki egyenleg ' + fmt(ix.bankBalance) + ' Ft (ez az irányadó)' : ''}.`}
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            placeholder="Mai egyenleg (Ft)"
            inputMode="numeric"
            value={bal}
            onChange={(e) => setBal(e.target.value.replace(/[^\d-]/g, ''))}
            style={{ ...inputStyle, width: 200 }}
          />
          <Pill
            kind="dark"
            onClick={() => {
              const v = parseInt(bal);
              if (isNaN(v)) return;
              run(() => api('/api/settings', { method: 'PUT', body: { opening_balance: String(v - ix.sumActualToToday) } }), 'Egyenleg beállítva');
              setBal('');
            }}
          >
            Mentés
          </Pill>
        </div>
      </Section>
      <Section
        title="Excel import"
        sub="A korábbi „TÉNYEK” és „TERVEK” xls fájlok formátuma (Dátum · Tétel · Kategória · Összeg). Ismételt importnál a már meglévő sorok nem duplikálódnak. A fájlok csak a böngészőben kerülnek feldolgozásra, nem tároljuk őket."
      >
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label
            style={{
              ...inputStyle,
              display: 'inline-flex',
              alignItems: 'center',
              cursor: 'pointer',
              background: C.navy,
              color: '#fff',
              fontWeight: 600,
              borderRadius: 999,
              padding: '0 18px',
            }}
          >
            {busy === 'actual' ? 'Feldolgozás…' : 'Tények (TÉNYEK.xls) importálása'}
            <input
              type="file"
              accept=".xls,.xlsx,.csv"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && importXls(e.target.files[0], 'actual')}
            />
          </label>
          <label
            style={{
              ...inputStyle,
              display: 'inline-flex',
              alignItems: 'center',
              cursor: 'pointer',
              background: C.blue,
              color: '#fff',
              fontWeight: 600,
              borderRadius: 999,
              padding: '0 18px',
            }}
          >
            {busy === 'plan' ? 'Feldolgozás…' : 'Tervek (TERVEK.xls) importálása'}
            <input
              type="file"
              accept=".xls,.xlsx,.csv"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && importXls(e.target.files[0], 'plan')}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13px ${FONT}`, color: C.muted }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} style={{ accentColor: C.blue }} />
            Az új tervfájl lecseréli a korábban importált, még nyitott terveket (a fájl első dátumától)
          </label>
        </div>
        <div style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
          Jelenleg: {data.entries.filter((e) => e.kind === 'actual').length} tény ({ix.firstActual || '—'} – {ix.lastActual || '—'}),{' '}
          {data.entries.filter((e) => e.kind === 'plan').length} terv.
        </div>
      </Section>
    </>
  );
}

function Categories() {
  const { ix, data, run, isAdmin, canEdit } = useStore();
  const [nl, setNl] = useState<Record<string, string>>({});
  const [ng, setNg] = useState({ section: 'out', label: '' });
  const [showArchived, setShowArchived] = useState(false);
  const used = new Set(data.entries.map((e) => e.leaf_id));
  return (
    <>
      {isAdmin && (
        <Section title="Új csoport">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Seg
              small
              value={ng.section}
              onChange={(v) => setNg({ ...ng, section: v })}
              options={[
                ['in', 'Bevétel'],
                ['out', 'Kiadás'],
              ]}
            />
            <input
              placeholder="pl. 6 Beruházás"
              value={ng.label}
              onChange={(e) => setNg({ ...ng, label: e.target.value })}
              style={{ ...inputStyle, flex: '1 1 200px' }}
            />
            <Pill
              kind="dark"
              onClick={() => ng.label && run(() => api('/api/groups', { body: ng }), 'Csoport létrehozva').then(() => setNg({ ...ng, label: '' }))}
            >
              Hozzáadás
            </Pill>
          </div>
        </Section>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13px ${FONT}`, color: C.muted }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ accentColor: C.blue }} />
        Archivált alkategóriák mutatása (az archivált nem jelenik meg a választólistákban és a becslésben)
      </label>
      {ix.groups.map((g) => (
        <Section key={g.id} title={`${g.section === 'in' ? 'Bevétel' : 'Kiadás'} · ${displayGroup(g.label)}`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ix.leaves
              .filter((l) => l.group_id === g.id && (showArchived || !l.archived))
              .map((l) => (
                <span
                  key={l.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    border: `1px solid ${C.line2}`,
                    borderRadius: 999,
                    padding: '4px 6px 4px 12px',
                    font: `500 13px ${FONT}`,
                    color: l.archived ? C.faint : C.ink,
                    background: '#fff',
                  }}
                >
                  {l.label}
                  {!used.has(l.id) && <span style={{ ...eyebrow, fontSize: 9 }}>üres</span>}
                  {canEdit && (
                    <>
                      <button
                        title="Átnevezés"
                        onClick={() => {
                          const v = prompt('Új név', l.label);
                          if (v && v.trim()) run(() => api(`/api/leaves/${l.id}`, { method: 'PATCH', body: { label: v.trim() } }), 'Átnevezve');
                        }}
                        style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.muted }}
                      >
                        ✎
                      </button>
                      <button
                        title={l.archived ? 'Visszaállítás' : 'Archiválás'}
                        onClick={() =>
                          run(
                            () => api(`/api/leaves/${l.id}`, { method: 'PATCH', body: { archived: !l.archived } }),
                            l.archived ? 'Visszaállítva' : 'Archiválva',
                          )
                        }
                        style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.muted }}
                      >
                        {l.archived ? '↺' : '×'}
                      </button>
                    </>
                  )}
                </span>
              ))}
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="Új alkategória (pl. új ügyfél neve)"
                value={nl[g.id] || ''}
                onChange={(e) => setNl({ ...nl, [g.id]: e.target.value })}
                style={{ ...inputStyle, flex: 1, height: 34 }}
              />
              <Pill
                small
                kind="light"
                onClick={() =>
                  nl[g.id] &&
                  run(() => api('/api/leaves', { body: { group_id: g.id, label: nl[g.id] } }), 'Alkategória hozzáadva').then(() => setNl({ ...nl, [g.id]: '' }))
                }
              >
                + Hozzáad
              </Pill>
            </div>
          )}
        </Section>
      ))}
    </>
  );
}
