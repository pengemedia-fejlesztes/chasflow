// Termékek, szolgáltatások: a számlázható tételek törzse (név, egység, nettó ár, ÁFA, pénznem, számlázási ütem),
// és a havi „Számlázandó” lista: melyik partnernek mit kell az adott hónapban kiszámlázni.
import { useMemo, useState, type CSSProperties } from 'react';
import {
  BILLINGS,
  BILLING_LABEL,
  CURRENCIES,
  UNITS,
  VATS,
  billablesFor,
  effective,
  grossOf,
  monthlyValue,
  type Billing,
  type Product,
  type ProductKind,
  type Vat,
} from '../../shared/catalog';
import { normalizeText } from '../../shared/categories';
import { addMonths, monthLong } from '../../shared/model';
import { api } from './api';
import { money } from './PartnerBilling';
import { useAllPartners } from './PartnerCard';
import { MoneyInput } from './PartnerModal';
import { useStore } from './store';
import { CALL_DAYS, defaultCallDays } from '../../shared/tasks';
import { availOf, useInventory } from './StockView';
import { C, FONT, FONT_H, Field, Pill, Seg, card, inputStyle } from './ui';
import { fmt } from '../../shared/model';

const KIND_LABEL: Record<ProductKind, string> = { szolgaltatas: 'Szolgáltatás', termek: 'Termék' };
const th: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: '#626A75' };

export function CatalogView() {
  const { data, canEdit } = useStore();
  const [tab, setTab] = useState<'list' | 'bill'>(() => (location.hash.includes('t=bill') ? 'bill' : 'list'));
  const go = (t: 'list' | 'bill') => {
    setTab(t);
    history.replaceState(null, '', `#/products${t === 'bill' ? '?t=bill' : ''}`);
  };
  const [creating, setCreating] = useState(false);
  return (
    <div style={{ padding: '24px 28px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, font: `800 32px/1.05 ${FONT_H}`, color: C.navy }}>Termékek, szolgáltatások</h1>
          <p style={{ margin: '8px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted }}>
            A számlázható tételek törzse. A partner adatlapján (Szolgáltatások és számlázás fül) rendeled hozzá a partnerhez, a „Számlázandó” fül havonta
            összegyűjti, kinek mit kell kiszámlázni.
          </p>
        </div>
        {canEdit && <SyncButton />}
        {canEdit && tab === 'list' && (
          <button
            type="button"
            className="hov-primary"
            onClick={() => setCreating(true)}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '12px 22px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
          >
            + Új termék, szolgáltatás
          </button>
        )}
      </div>
      {data.catalogError && <div style={{ ...card, padding: 14, color: C.neg, font: `500 14px ${FONT}` }}>{data.catalogError}</div>}
      <Seg
        value={tab}
        onChange={go}
        options={[
          ['list', `Törzs (${(data.products || []).filter((p) => !p.archived).length})`],
          ['bill', 'Számlázandó'],
        ]}
      />
      {tab === 'list' ? <ProductList creating={creating} setCreating={setCreating} /> : <BillableList />}
    </div>
  );
}

function ProductList({ creating, setCreating }: { creating: boolean; setCreating: (v: boolean) => void }) {
  const { data } = useStore();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | ProductKind>('all');
  const [archived, setArchived] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const products = data.products || [];
  const assigns = data.partnerProducts || [];
  const inv = useInventory();
  const ym = data.today.slice(0, 7);
  const usage = useMemo(() => {
    const m = new Map<string, { n: number; monthly: number }>();
    for (const a of assigns) {
      if (a.end_ym && a.end_ym < ym) continue;
      const p = products.find((x) => x.id === a.product_id);
      const e = effective(a, p);
      const x = m.get(a.product_id) || { n: 0, monthly: 0 };
      x.n++;
      x.monthly += monthlyValue(e.net, e.billing);
      m.set(a.product_id, x);
    }
    return m;
  }, [assigns, products, ym]);
  const nq = normalizeText(q);
  const list = products
    .filter((p) => (archived ? true : !p.archived))
    .filter((p) => kind === 'all' || p.kind === kind)
    .filter((p) => !nq || normalizeText(`${p.name} ${p.sku || ''} ${p.note || ''}`).includes(nq));
  const selP = creating ? null : list.find((p) => p.id === sel) || list[0] || null;
  const COLS = 'minmax(160px,1.8fr) 100px 130px 60px 90px 80px 120px';
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg
          value={kind}
          onChange={setKind}
          options={[
            ['all', 'Mind'],
            ['szolgaltatas', 'Szolgáltatások'],
            ['termek', 'Termékek'],
          ]}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Keresés névben, cikkszámban…"
          aria-label="Termék keresése"
          style={{ ...inputStyle, height: 42, width: 340, borderRadius: 999, padding: '0 18px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, font: `500 14px ${FONT}`, color: C.muted }}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> archiváltak is
        </label>
        <span style={{ marginLeft: 'auto', font: `400 13.5px ${FONT}`, color: C.muted }}>{list.length} tétel</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 560px), 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '12px 18px', borderBottom: `1px solid ${C.line}` }}>
            <span style={th}>Megnevezés</span>
            <span style={th}>Ütem</span>
            <span style={{ ...th, textAlign: 'right' }}>Nettó ár</span>
            <span style={{ ...th, textAlign: 'right' }}>ÁFA</span>
            <span style={{ ...th, textAlign: 'right' }}>Elérhető</span>
            <span style={{ ...th, textAlign: 'right' }}>Partner</span>
            <span style={{ ...th, textAlign: 'right' }}>Havi nettó</span>
          </div>
          {!products.length && (
            <div className="empty-state" style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>
              Még nincs termék vagy szolgáltatás. Vedd fel az elsőt a „+ Új termék, szolgáltatás” gombbal.
            </div>
          )}
          {products.length > 0 && !list.length && (
            <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Nincs találat.</div>
          )}
          {list.map((p) => {
            const on = p.id === selP?.id;
            const u = usage.get(p.id);
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                onClick={() => (setCreating(false), setSel(p.id))}
                onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), setCreating(false), setSel(p.id))}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COLS,
                  gap: 12,
                  alignItems: 'center',
                  padding: '10px 18px 10px 15px',
                  borderTop: `1px solid ${C.line3}`,
                  borderLeft: `3px solid ${on ? C.blue : 'transparent'}`,
                  background: on ? C.bg2 : '#fff',
                  cursor: 'pointer',
                  opacity: p.archived ? 0.55 : 1,
                }}
              >
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <b style={{ font: `600 15px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</b>
                  <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                    {KIND_LABEL[p.kind]}
                    {p.sku ? ` · ${p.sku}` : ''}
                    {p.archived ? ' · archivált' : ''}
                    {p.call_days ? ` · hívás ${p.call_days} nappal előtte` : ''}
                  </span>
                </span>
                <span style={{ font: `400 13.5px ${FONT}`, color: C.ink }}>{BILLING_LABEL[p.billing]}</span>
                <b style={{ textAlign: 'right', font: `600 14.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
                  {money(p.price, p.currency)}
                  <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>/{p.unit}</span>
                </b>
                <span style={{ textAlign: 'right', font: `400 13.5px ${FONT}`, color: C.ink }}>{/^\d+$/.test(p.vat) ? `${p.vat}%` : p.vat}</span>
                {(() => {
                  const av = availOf(inv, p.id);
                  return (
                    <span style={{ textAlign: 'right', font: `500 14px ${FONT}`, color: av === null ? C.faint : av > 0 ? C.inc : C.neg }}>
                      {av === null ? '–' : `${fmt(av)} ${p.unit}`}
                    </span>
                  );
                })()}
                <span style={{ textAlign: 'right', font: `500 14px ${FONT}`, color: u?.n ? C.ink : C.faint }}>{u?.n || '–'}</span>
                <span style={{ textAlign: 'right', font: `600 14px ${FONT}`, color: u?.monthly ? C.inc : C.faint, fontVariantNumeric: 'tabular-nums' }}>
                  {u?.monthly ? money(u.monthly, p.currency) : '–'}
                </span>
              </div>
            );
          })}
        </div>
        {(creating || selP) && (
          <ProductEditor
            key={creating ? 'new' : selP!.id + selP!.updated_at}
            p={creating ? null : selP}
            onSaved={(id) => (setCreating(false), setSel(id))}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    </>
  );
}

function ProductEditor({ p, onSaved, onCancel }: { p: Product | null; onSaved: (id: string) => void; onCancel: () => void }) {
  const { data, run, canEdit, openPartner } = useStore();
  const partners = useAllPartners();
  const [name, setName] = useState(p?.name || '');
  const [kind, setKind] = useState<ProductKind>(p?.kind || 'szolgaltatas');
  const [unit, setUnit] = useState(p?.unit || 'hó');
  const [price, setPrice] = useState(p ? String(Math.round(p.price)) : '');
  const [vat, setVat] = useState<Vat>(p?.vat || '27');
  const [currency, setCurrency] = useState(p?.currency || 'HUF');
  const [billing, setBilling] = useState<Billing>(p?.billing || 'havi');
  const [sku, setSku] = useState(p?.sku || '');
  const [grp, setGrp] = useState(p?.grp || '');
  const [callDays, setCallDays] = useState<string>(p ? String(p.call_days ?? '') : '');
  const inv = useInventory();
  const [note, setNote] = useState(p?.note || '');
  const [busy, setBusy] = useState(false);
  const users = (data.partnerProducts || []).filter((a) => p && a.product_id === p.id);
  const ym = data.today.slice(0, 7);
  const save = async (extra: Record<string, unknown> = {}) => {
    if (busy || !name.trim()) return;
    setBusy(true);
    let id = p?.id || '';
    const ok = await run(
      async () => {
        const r = await api<{ id: string }>(p ? `/api/products/${encodeURIComponent(p.id)}` : '/api/products', {
          method: p ? 'PUT' : 'POST',
          body: {
            name,
            kind,
            unit,
            price: Number(price || 0),
            vat,
            currency,
            billing,
            sku,
            note,
            grp,
            call_days: callDays === '' ? null : Number(callDays),
            ...extra,
          },
        });
        id = r.id;
      },
      `${name}: ${p ? 'mentve' : 'felvéve a törzsbe'}`,
    );
    setBusy(false);
    if (ok) onSaved(id);
  };
  const remove = async () => {
    if (!p) return;
    const msg = users.length
      ? `${p.name} ${users.length} partnernél használatban van, ezért csak archiválható (a meglévő hozzárendelések megmaradnak). Archiválod?`
      : `Törlöd a törzsből: ${p.name}?`;
    if (!confirm(msg)) return;
    await run(() => api(`/api/products/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), users.length ? 'Archiválva' : 'Törölve');
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  const net = Number(price || 0);
  return (
    <form
      onSubmit={(ev) => (ev.preventDefault(), save())}
      style={{ ...card, position: 'sticky', top: 16, padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <b style={{ font: `800 22px/1.15 ${FONT_H}`, color: C.navy }}>{p ? p.name : 'Új termék, szolgáltatás'}</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Field label="Megnevezés (a számlán így szerepel)" style={{ gridColumn: '1 / -1' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required disabled={!canEdit} style={sel} autoFocus={!p} />
        </Field>
        <Field label="Típus">
          <select value={kind} onChange={(e) => setKind(e.target.value as ProductKind)} disabled={!canEdit} style={sel}>
            <option value="szolgaltatas">Szolgáltatás</option>
            <option value="termek">Termék</option>
          </select>
        </Field>
        <Field label="Mennyiségi egység">
          <select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!canEdit} style={sel}>
            {[...new Set([...UNITS, unit])].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nettó egységár">
          <MoneyInput value={price} onChange={setPrice} disabled={!canEdit} placeholder="0" style={sel} />
        </Field>
        <Field label="Pénznem">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!canEdit} style={sel}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="ÁFA">
          <select value={vat} onChange={(e) => setVat(e.target.value as Vat)} disabled={!canEdit} style={sel}>
            {VATS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Számlázás">
          <select
            value={billing}
            onChange={(e) => {
              const b = e.target.value as Billing;
              setBilling(b);
              // új tételnél az ütemhez illő alapértelmezett emlékeztető (évente 30, negyed-/félévente 7 nap)
              if (!p) setCallDays(String(defaultCallDays(b) ?? ''));
            }}
            disabled={!canEdit}
            style={sel}
          >
            {BILLINGS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cikkszám / belső kód">
          <input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={60} disabled={!canEdit} style={sel} />
        </Field>
        <Field label="Hívás a számlázás előtt">
          <select value={callDays} onChange={(e) => setCallDays(e.target.value)} disabled={!canEdit} style={sel}>
            <option value="">Nincs emlékeztető</option>
            {CALL_DAYS.map((d) => (
              <option key={d} value={String(d)}>
                {d} nappal előtte (Telefon feladat)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Termékcsoport">
          <input
            value={grp}
            onChange={(e) => setGrp(e.target.value)}
            list="cf-groups"
            maxLength={80}
            disabled={!canEdit}
            placeholder="pl. Késztermékek"
            style={sel}
          />
          <datalist id="cf-groups">
            {[...new Set((data.products || []).map((x) => x.grp).filter(Boolean))].map((g) => (
              <option key={g!} value={g!} />
            ))}
          </datalist>
        </Field>
        <Field label="Leírás, megjegyzés" style={{ gridColumn: '1 / -1' }}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={3}
            disabled={!canEdit}
            style={{ ...inputStyle, height: 'auto', padding: 10, resize: 'vertical' }}
          />
        </Field>
      </div>
      <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>
        Bruttó egységár: <b style={{ color: C.navy }}>{money(grossOf(net, vat), currency)}</b>
        {p && inv.get(p.id)?.tracked && (
          <>
            {' '}
            · raktáron {fmt(inv.get(p.id)!.onHand)}, lefoglalva {fmt(inv.get(p.id)!.reserved)}, elérhető:{' '}
            <b style={{ color: C.navy }}>
              {fmt(inv.get(p.id)!.available)} {p.unit}
            </b>{' '}
            · <a href="#/stock">Raktárkészlet ›</a>
          </>
        )}
      </span>
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className={busy ? 'is-loading' : undefined}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '10px 22px', font: `600 14px ${FONT}`, cursor: 'pointer' }}
          >
            {p ? 'Mentés' : 'Felvétel'}
          </button>
          {!p && (
            <Pill small onClick={onCancel}>
              Mégse
            </Pill>
          )}
          {p?.archived ? (
            <Pill small onClick={() => save({ archived: 0 })}>
              Visszaállítás
            </Pill>
          ) : null}
          {p && !p.archived && (
            <button
              type="button"
              onClick={remove}
              style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: C.neg, font: `600 14px ${FONT}`, cursor: 'pointer' }}
            >
              {users.length ? 'Archiválás' : 'Törlés'}
            </button>
          )}
        </div>
      )}
      {p && (
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={th}>Partnerek ({users.length})</span>
          {canEdit && !p.archived && <AssignToPartner product={p} taken={new Set(users.map((a) => a.partner_key))} />}
          {!users.length && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Még egy partnerhez sincs hozzárendelve.</span>}
          {users.map((a) => {
            const pt = partners.find((x) => x.key === a.partner_key);
            const e = effective(a, p);
            const ended = a.end_ym && a.end_ym < ym;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => openPartner(a.partner_key)}
                className="hov-row"
                style={{
                  display: 'flex',
                  gap: 8,
                  border: 0,
                  background: C.bg,
                  borderRadius: 6,
                  padding: '8px 10px',
                  font: `400 13.5px ${FONT}`,
                  color: C.ink,
                  cursor: 'pointer',
                  textAlign: 'left',
                  opacity: ended ? 0.6 : 1,
                }}
              >
                <span style={{ flex: 1 }}>
                  <b style={{ color: C.navy }}>{pt?.name || a.partner_key}</b> · {BILLING_LABEL[e.billing].toLowerCase()}
                  {ended ? ' · lejárt' : ''}
                </span>
                <b style={{ fontVariantNumeric: 'tabular-nums', color: C.navy }}>{money(e.net, p.currency)}</b>
              </button>
            );
          })}
        </div>
      )}
    </form>
  );
}

function BillableList() {
  const { data, openPartner } = useStore();
  const partners = useAllPartners();
  const [ym, setYm] = useState(data.today.slice(0, 7));
  const products = data.products || [];
  const lines = billablesFor(ym, data.partnerProducts || [], products);
  const groups = useMemo(() => {
    const m = new Map<string, typeof lines>();
    for (const l of lines) m.set(l.assign.partner_key, [...(m.get(l.assign.partner_key) || []), l]);
    return [...m.entries()]
      .map(([k, ls]) => ({ key: k, name: partners.find((p) => p.key === k)?.name || k, lines: ls }))
      .sort((a, b) => a.name.localeCompare(b.name, 'hu'));
  }, [lines, partners]);
  const tot = (cur: string, f: 'net' | 'gross') => lines.filter((l) => (l.product?.currency || 'HUF') === cur).reduce((s, l) => s + l[f], 0);
  const curs = [...new Set(lines.map((l) => l.product?.currency || 'HUF'))];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Pill small onClick={() => setYm(addMonths(ym, -1))}>
          ‹ előző
        </Pill>
        <b style={{ font: `700 20px ${FONT_H}`, color: C.navy, minWidth: 170, textAlign: 'center' }}>{monthLong(ym)}</b>
        <Pill small onClick={() => setYm(addMonths(ym, 1))}>
          következő ›
        </Pill>
        <span style={{ marginLeft: 'auto', font: `500 14px ${FONT}`, color: C.muted }}>
          {groups.length} partner · {lines.length} tétel
          {curs.map((c) => ` · nettó ${money(tot(c, 'net'), c)} / bruttó ${money(tot(c, 'gross'), c)}`).join('')}
        </span>
      </div>
      {!groups.length && (
        <div className="empty-state" style={{ ...card, padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>
          Ebben a hónapban nincs kiszámlázandó szolgáltatás. A partner adatlapján, a „Szolgáltatások és számlázás” fülön rendelhetsz hozzá.
        </div>
      )}
      {groups.map((g) => {
        const prof = data.partnerProfiles?.[g.key];
        const pt = partners.find((p) => p.key === g.key);
        const miss = [!prof?.company && 'cégnév', !(prof?.zip && prof?.city && prof?.address) && 'cím', !pt?.info?.tax_number && 'adószám'].filter(Boolean);
        return (
          <div key={g.key} style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="partner-link"
                onClick={() => openPartner(g.key)}
                style={{ border: 0, background: 'transparent', padding: 0, font: `700 16px ${FONT}`, color: C.navy, cursor: 'pointer' }}
              >
                {g.name}
              </button>
              <span style={{ font: `400 13px ${FONT}`, color: miss.length ? C.neg : C.muted }}>
                {miss.length ? `hiányzó számlázási adat: ${miss.join(', ')}` : [prof?.company, prof?.billing_email || prof?.email].filter(Boolean).join(' · ')}
                {prof?.pay_days != null ? ` · fizetés ${prof.pay_days} nap` : ''}
              </span>
              <b style={{ marginLeft: 'auto', font: `700 15px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
                {money(
                  g.lines.reduce((s, l) => s + l.net, 0),
                  g.lines[0].product?.currency,
                )}{' '}
                <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>nettó</span>
              </b>
            </div>
            {g.lines.map((l) => (
              <div
                key={l.assign.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1.6fr) 120px 110px 130px 130px',
                  gap: 12,
                  padding: '10px 18px',
                  borderTop: `1px solid ${C.line3}`,
                  font: `400 14px ${FONT}`,
                  color: C.ink,
                  alignItems: 'center',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <b style={{ color: C.navy }}>{l.product?.name || 'Törölt termék'}</b>
                  {l.assign.note ? <span style={{ color: C.muted }}> · {l.assign.note}</span> : null}
                </span>
                <span>{BILLING_LABEL[l.billing]}</span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {String(l.assign.qty).replace('.', ',')} {l.product?.unit || 'db'}
                </span>
                <b style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: C.navy }}>{money(l.net, l.product?.currency)}</b>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: C.muted }}>bruttó {money(l.gross, l.product?.currency)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** a partnerek tételeiből hiányzó termékek és hozzárendelések pótlása */
function SyncButton() {
  const { run, showToast } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={busy ? 'is-loading' : undefined}
      onClick={async () => {
        setBusy(true);
        let r: { products: number; assigns: number } = { products: 0, assigns: 0 };
        const ok = await run(async () => {
          r = await api('/api/products/sync', { method: 'POST', body: {} });
        });
        setBusy(false);
        if (ok)
          showToast(
            r.products || r.assigns ? `${r.products} új termék, ${r.assigns} új hozzárendelés a partnerek tételeiből` : 'Nincs új tétel a partnereknél',
          );
      }}
      style={{
        border: `1px solid ${C.line2}`,
        borderRadius: 999,
        background: '#fff',
        color: C.navy,
        padding: '11px 18px',
        font: `600 14px ${FONT}`,
        cursor: 'pointer',
      }}
    >
      ↻ Frissítés a partnerektől
    </button>
  );
}

/** a termék hozzárendelése egy partnerhez a termék oldaláról (a partner adatlapján is megjelenik) */
function AssignToPartner({ product, taken }: { product: Product; taken: Set<string> }) {
  const { data, run } = useStore();
  const partners = useAllPartners();
  const [q, setQ] = useState('');
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);
  const match = partners.find((p) => normalizeText(p.name) === normalizeText(q));
  const listId = 'cf-partners-' + product.id;
  const save = async () => {
    if (!match || busy) return;
    setBusy(true);
    const ok = await run(
      () =>
        api('/api/partner-products', {
          method: 'POST',
          body: { partner_key: match.key, product_id: product.id, qty: qty.replace(',', '.'), start_ym: data.today.slice(0, 7) },
        }),
      `${match.name}: ${product.name} hozzárendelve`,
    );
    setBusy(false);
    if (ok) setQ('');
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())}
        list={listId}
        placeholder="Partner neve…"
        aria-label="Partner kiválasztása a hozzárendeléshez"
        style={{ ...inputStyle, height: 38, flex: '1 1 180px' }}
      />
      <datalist id={listId}>
        {partners
          .filter((p) => !taken.has(p.key) && !p.leaves.every((l) => l.archived))
          .map((p) => (
            <option key={p.key} value={p.name} />
          ))}
      </datalist>
      <input
        value={qty}
        onChange={(e) => setQty(e.target.value.replace(/[^\d,.]/g, ''))}
        inputMode="decimal"
        aria-label="Mennyiség"
        style={{ ...inputStyle, height: 38, width: 70 }}
      />
      <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>{product.unit}</span>
      <Pill small kind={match ? 'primary' : 'light'} onClick={save}>
        + Hozzárendelés
      </Pill>
    </div>
  );
}
