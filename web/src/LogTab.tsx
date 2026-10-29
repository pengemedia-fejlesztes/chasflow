// Változásnapló: ki, mikor, mit vitt fel / módosított / törölt / vont össze – szűrhető, és a lépések visszavonhatók.
import { useEffect, useMemo, useState } from 'react';
import { normalizeText } from '../../shared/categories';
import { fmt } from '../../shared/model';
import { api, ApiError } from './api';
import { useStore } from './store';
import { C, FONT, Pill, Seg, card, inputStyle, relTime } from './ui';

interface Item {
  op: 'new' | 'edit' | 'del';
  name: string;
  leaf: string;
  date: string;
  amount: number;
  kind: string;
  prev?: Partial<{ amount: number; date: string; name: string; leaf: string; done: number; tentative: number; kind: string }>;
}
interface LogRow {
  id: number;
  ts: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  summary: string;
  leaf_ids: string;
  items: string | null;
  undoable: number;
  undone_at: number | null;
  undone_by_name: string | null;
  undo_of: number | null;
}
interface SysRow {
  id: number;
  ts: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  detail: string | null;
}

type Kind = 'all' | 'new' | 'edit' | 'del' | 'merge' | 'partner' | 'undo' | 'system';
const KIND_LABEL: Record<Exclude<Kind, 'all'>, string> = {
  new: 'Felvitel',
  edit: 'Módosítás',
  del: 'Törlés',
  merge: 'Összevonás',
  partner: 'Partner',
  undo: 'Visszavonás',
  system: 'Rendszer',
};
const SYS_LABEL: Record<string, string> = {
  login: 'Belépés',
  login_failed: 'Sikertelen belépés',
  sync: 'Billingo-szinkron',
  nav_sync: 'NAV-szinkron',
  import: 'XLS import',
  bank_approve: 'Banki tételek jóváhagyva',
  bank_auto_approve: 'Banki tételek automatikusan könyvelve',
  bank_csv_import: 'Banki CSV import',
  billingo_autopay: 'Billingo: fizetettnek jelölve',
  rule_created: 'Párosítási szabály létrehozva',
  rule_updated: 'Párosítási szabály módosítva',
  rule_deleted: 'Párosítási szabály törölve',
  partner_updated: 'Partneradat módosítva',
  partner_rule_updated: 'Partner-párosítás módosítva',
  group_updated: 'Mappa módosítva',
  settings: 'Beállítások módosítva',
  worktime_import: 'Munkaidő import',
  'flags.ack': 'Riasztás rendben jelölve',
  'flags.unack': 'Riasztás visszanyitva',
  'leaf.link': 'Partner összekapcsolva',
  'stats.refresh': 'Statisztika frissítve',
  user_created: 'Felhasználó létrehozva',
  user_updated: 'Felhasználó módosítva',
  user_deleted: 'Felhasználó törölve',
  password_changed: 'Jelszócsere',
};

function kindsOf(r: LogRow, items: Item[]): Kind[] {
  if (r.action === 'undo') return ['undo'];
  if (r.action === 'leaf.merge') return ['merge'];
  if (r.action === 'leaf.update') return ['partner'];
  if (r.action === 'trash.restore') return ['new'];
  const k = new Set<Kind>(items.map((i) => i.op));
  return k.size ? [...k] : ['edit'];
}

const dt = (ms: number) => new Date(ms).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' });
const dot = (d: string) => (d ? d.replace(/-/g, '.') + '.' : '');
const DAY = 86400000;

export function LogTab() {
  const { ix, canEdit, reload, showToast } = useStore();
  const [range, setRange] = useState<'7' | '30' | '90' | '365'>('30');
  const [data, setData] = useState<{ items: LogRow[]; system: SysRow[] } | null>(null);
  const [n, setN] = useState(0);
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    setData(null);
    api<{ items: LogRow[]; system: SysRow[] }>(`/api/changelog?sys=1&from=${Date.now() - Number(range) * DAY}`)
      .then(setData)
      .catch(() => setData({ items: [], system: [] }));
  }, [range, n]);

  const leafName = (id: string) => ix.leafById[id]?.label || id;

  const rows = useMemo(() => {
    if (!data) return null;
    const words = normalizeText(q).split(/\s+/).filter(Boolean);
    const list: { key: string; ts: number; user: string; kinds: Kind[]; log?: LogRow; items: Item[]; sys?: SysRow; text: string }[] = [];
    for (const r of data.items) {
      const items: Item[] = r.items ? JSON.parse(r.items) : [];
      const leaves = r.leaf_ids.split(',').filter(Boolean).map(leafName);
      list.push({
        key: 'c' + r.id,
        ts: r.ts,
        user: r.user_name || 'rendszer',
        kinds: kindsOf(r, items),
        log: r,
        items,
        text: `${r.summary} ${leaves.join(' ')} ${items.map((i) => `${i.name} ${i.prev?.name || ''} ${Math.abs(i.amount)}`).join(' ')}`,
      });
    }
    for (const s of data.system)
      list.push({ key: 's' + s.id, ts: s.ts, user: s.user_name || 'rendszer', kinds: ['system'], sys: s, items: [], text: `${SYS_LABEL[s.action] || s.action} ${s.detail || ''}` });
    return list
      .filter((x) => (!who || x.user === who) && (kind === 'all' || x.kinds.includes(kind)))
      .filter((x) => {
        if (!words.length) return true;
        const hay = normalizeText(`${x.user} ${x.text}`);
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 500);
  }, [data, q, who, kind, ix]); // eslint-disable-line react-hooks/exhaustive-deps

  const users = useMemo(() => [...new Set([...(data?.items || []), ...(data?.system || [])].map((r) => r.user_name || 'rendszer'))].sort(), [data]);

  const undo = async (r: LogRow, force = false) => {
    if (!force && !confirm(`Visszavonod ezt a lépést?\n\n${r.summary}`)) return;
    setBusy(r.id);
    try {
      await api(`/api/changelog/${r.id}/undo`, { body: { force } });
      showToast({ msg: 'Visszavonva: ' + r.summary });
      reload();
      setN((x) => x + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm(e.message + '\n\nMégis visszavonod?')) {
          setBusy(null);
          return undo(r, true);
        }
      } else showToast({ msg: (e as Error).message, error: true });
    }
    setBusy(null);
  };

  const chip = (k: Kind) => {
    const col = k === 'del' || k === 'undo' ? '#B3261E' : k === 'new' ? '#1E7A46' : k === 'system' ? C.muted : C.blueDark;
    return (
      <span key={k} style={{ font: `600 11px ${FONT}`, color: col, background: C.bg, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>
        {k === 'all' ? '' : KIND_LABEL[k]}
      </span>
    );
  };

  const itemLine = (i: Item, j: number) => {
    const p = i.prev || {};
    const ch: string[] = [];
    if (p.name !== undefined) ch.push(`név: ${p.name || '–'} → ${i.name}`);
    if (p.amount !== undefined) ch.push(`összeg: ${fmt(Math.abs(p.amount))} → ${fmt(Math.abs(i.amount))} Ft`);
    if (p.date !== undefined) ch.push(`dátum: ${dot(p.date)} → ${dot(i.date)}`);
    if (p.leaf !== undefined) ch.push(`partner: ${leafName(p.leaf)} → ${leafName(i.leaf)}`);
    if (p.done !== undefined) ch.push(i.prev?.done ? 'újranyitva' : 'lezárva / párosítva');
    if (p.tentative !== undefined) ch.push(p.tentative ? 'ajánlatból elfogadva' : 'ajánlattá téve');
    return (
      <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '4px 0', borderTop: `1px solid ${C.line3}`, font: `500 12.5px ${FONT}`, color: C.ink }}>
        <span style={{ minWidth: 64, font: `600 11px ${FONT}`, color: i.op === 'del' ? '#B3261E' : i.op === 'new' ? '#1E7A46' : C.blueDark }}>
          {i.op === 'new' ? 'felvéve' : i.op === 'del' ? 'törölve' : 'módosítva'}
        </span>
        <span style={{ flex: '1 1 200px', minWidth: 0, textDecoration: i.op === 'del' ? 'line-through' : undefined }}>
          <b>{i.name || '(név nélkül)'}</b> · {leafName(i.leaf)} · {dot(i.date)} · {fmt(Math.abs(i.amount))} Ft{i.kind === 'actual' ? ' · tény' : ''}
          {ch.length ? <span style={{ color: C.muted }}> — {ch.join(' · ')}</span> : null}
        </span>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Minden módosítás ide kerül: ki, mikor, mit vitt fel, módosított, törölt vagy vont össze. A „Visszavonás” a lépés előtti állapotot állítja vissza (a
        létrehozott tételek a Törölt tételek közé kerülnek, nem vesznek el).
      </span>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Keresés: ügyfél, tétel, összeg…" style={{ ...inputStyle, flex: '1 1 240px' }} />
        <select value={who} onChange={(e) => setWho(e.target.value)} style={{ ...inputStyle, flex: '0 1 180px' }}>
          <option value="">Mindenki</option>
          {users.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <Seg
          small
          value={range}
          onChange={setRange}
          options={[
            ['7', '7 nap'],
            ['30', '30 nap'],
            ['90', '90 nap'],
            ['365', '1 év'],
          ]}
        />
      </div>
      <Seg small value={kind} onChange={setKind} options={[['all', 'Minden'], ...(Object.entries(KIND_LABEL) as [Kind, string][])]} />
      {rows === null && <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>Betöltés…</span>}
      {rows && !rows.length && <div style={{ ...card, padding: '18px 20px', font: `500 13.5px ${FONT}`, color: C.muted }}>Nincs a szűrőknek megfelelő bejegyzés.</div>}
      {rows?.map((x) => {
        const r = x.log;
        const isOpen = r && open === r.id;
        return (
          <div key={x.key} style={{ ...card, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 6, opacity: r?.undone_at ? 0.65 : 1 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div
                onClick={() => r && x.items.length && setOpen(isOpen ? null : r.id)}
                style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, cursor: r && x.items.length ? 'pointer' : 'default' }}
              >
                <span style={{ font: `600 13.5px ${FONT}`, color: C.ink, textDecoration: r?.undone_at ? 'line-through' : undefined }}>
                  {r ? r.summary : SYS_LABEL[x.sys!.action] || x.sys!.action}
                  {r && x.items.length ? <span style={{ color: C.blueDark, font: `600 12px ${FONT}` }}> {isOpen ? '▾' : '▸'} részletek</span> : null}
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', font: `400 12px ${FONT}`, color: C.muted }}>
                  {x.kinds.map(chip)}
                  <span>
                    {x.user} · {dt(x.ts)} ({relTime(x.ts)})
                  </span>
                  {r?.undone_at ? (
                    <b style={{ color: '#B3261E' }}>
                      visszavonta {r.undone_by_name || '?'}, {dt(r.undone_at)}
                    </b>
                  ) : null}
                </span>
              </div>
              {canEdit && r && r.undoable && !r.undone_at ? (
                <Pill small kind="light" onClick={() => undo(r)}>
                  {busy === r.id ? '…' : '↶ Visszavonás'}
                </Pill>
              ) : null}
            </div>
            {isOpen && <div>{x.items.map(itemLine)}</div>}
          </div>
        );
      })}
      {rows && rows.length >= 500 && <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>Az első 500 bejegyzés látszik – szűkítsd a keresést.</span>}
    </div>
  );
}
