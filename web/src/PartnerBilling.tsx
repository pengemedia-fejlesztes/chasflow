// Partner adatlap · „Szolgáltatások és számlázás”: a partner számlázási adatai (cím, e-mail, kapcsolattartó, fizetési
// határidő) és a neki számlázandó termékek / szolgáltatások (mennyiség, egyedi ár, ütem, kezdő és záró hónap).
import { useMemo, useState, type CSSProperties } from 'react';
import {
  BILLINGS,
  BILLING_LABEL,
  PROFILE_FIELDS,
  availableOf,
  billablesFor,
  effective,
  emptyProfile,
  monthlyValue,
  nextBilling,
  type Billing,
  type PartnerProduct,
  type PartnerProfile,
  type Product,
} from '../../shared/catalog';
import { addMonths, fmt, monthLong } from '../../shared/model';
import type { PartnerStat } from '../../shared/partners';
import { api } from './api';
import { MoneyInput } from './PartnerModal';
import { ProductCombo } from './ProductCombo';
import { normalizeText } from '../../shared/categories';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Pill, card, eyebrow, inputStyle, R } from './ui';

export const money = (v: number, cur = 'HUF') => `${fmt(v)} ${cur === 'HUF' ? 'Ft' : cur}`;
const digits = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Math.round(v)));

/** Szolgáltatások + számlázási adatok egy partnernek (adatlap fül és partnertörzs panel) */
export function PartnerBillingTab({ p, compact }: { p: PartnerStat; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PartnerServices p={p} compact={compact} />
      <PartnerProfileForm key={p.key} p={p} compact={compact} />
    </div>
  );
}

export function PartnerServices({ p, compact }: { p: PartnerStat; compact?: boolean }) {
  const { data, canEdit } = useStore();
  const products = data.products || [];
  const byId = useMemo(() => new Map(products.map((x) => [x.id, x])), [products]);
  const rows = (data.partnerProducts || []).filter((a) => a.partner_key === p.key);
  const ym = data.today.slice(0, 7);
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const active = rows.filter((a) => !a.end_ym || a.end_ym >= ym);
  const ended = rows.filter((a) => a.end_ym && a.end_ym < ym);
  const now = billablesFor(ym, rows, products);
  const monthly = active.reduce((s, a) => {
    const e = effective(a, byId.get(a.product_id));
    return s + monthlyValue(e.net, e.billing);
  }, 0);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ font: `700 19px ${FONT_H}`, color: C.navy, flex: 1 }}>Számlázandó szolgáltatások, termékek</b>
        <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
          {active.length} aktív · havi átlag nettó {money(monthly)} · {monthLong(ym)}: {now.length ? money(now.reduce((s, l) => s + l.net, 0)) : 'nincs'}
        </span>
      </div>
      {data.catalogError && <span style={{ color: C.neg, font: `500 13px ${FONT}` }}>{data.catalogError}</span>}
      <div style={{ ...card, overflow: 'hidden' }}>
        {!rows.length && edit !== 'new' && (
          <div className="empty-state" style={{ padding: 18, font: `400 14px ${FONT}`, color: C.muted }}>
            Ennek a partnernek még nincs hozzárendelt terméke vagy szolgáltatása.
          </div>
        )}
        {[...active, ...ended].map((a) =>
          edit === a.id ? (
            <AssignForm key={a.id} p={p} a={a} products={products} onDone={() => setEdit(null)} />
          ) : (
            <AssignRow key={a.id} a={a} product={byId.get(a.product_id)} ym={ym} compact={compact} onEdit={canEdit ? () => setEdit(a.id) : undefined} />
          ),
        )}
        {edit === 'new' && <AssignForm p={p} products={products} onDone={() => setEdit(null)} />}
      </div>
      {canEdit && edit !== 'new' && (
        <div>
          <Pill small onClick={() => setEdit('new')}>
            + Szolgáltatás / termék hozzárendelése
          </Pill>
        </div>
      )}
    </section>
  );
}

function AssignRow({ a, product, ym, compact, onEdit }: { a: PartnerProduct; product?: Product; ym: string; compact?: boolean; onEdit?: () => void }) {
  const e = effective(a, product);
  const next = nextBilling(a, e.billing, ym);
  const ended = !!a.end_ym && a.end_ym < ym;
  const cur = product?.currency || 'HUF';
  return (
    <div
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onClick={onEdit}
      onKeyDown={(ev) => onEdit && (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onEdit())}
      aria-label={onEdit ? `${product?.name || 'Törölt termék'} szerkesztése` : undefined}
      className={onEdit ? 'hov-row' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: compact ? 'minmax(0,1fr) auto' : 'minmax(0,1.6fr) minmax(0,1fr) 130px 130px',
        gap: 12,
        alignItems: 'center',
        padding: '12px 16px',
        borderTop: `1px solid ${C.line3}`,
        cursor: onEdit ? 'pointer' : 'default',
        opacity: ended ? 0.6 : 1,
      }}
    >
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <b style={{ font: `600 15px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {product?.name || 'Törölt termék'}
          {product?.archived ? <span style={{ font: `500 12px ${FONT}`, color: C.muted }}> · archivált</span> : null}
        </b>
        <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
          {fmtQty(a.qty)} {product?.unit || 'db'} × {money(e.price, cur)}
          {a.price !== null ? ' (egyedi ár)' : ''}
          {a.note ? ` · ${a.note}` : ''}
        </span>
      </span>
      {!compact && (
        <span style={{ font: `400 13.5px ${FONT}`, color: C.ink }}>
          {BILLING_LABEL[e.billing]} · {monthLong(a.start_ym)}–{a.end_ym ? monthLong(a.end_ym) : 'folyamatos'}
        </span>
      )}
      {!compact && (
        <span style={{ font: `400 13px ${FONT}`, color: ended ? C.faint : next === ym ? C.inc : C.muted }}>
          {ended ? 'lejárt' : next ? (next === ym ? 'számlázandó most' : `köv.: ${monthLong(next)}`) : 'nincs több'}
        </span>
      )}
      <span style={{ textAlign: 'right', display: 'flex', flexDirection: 'column' }}>
        <b style={{ font: `700 15px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{money(e.net, cur)}</b>
        <span style={{ font: `400 12px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>bruttó {money(e.gross, cur)}</span>
      </span>
    </div>
  );
}

const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : String(q).replace('.', ','));

function AssignForm({ p, a, products, onDone }: { p: PartnerStat; a?: PartnerProduct; products: Product[]; onDone: () => void }) {
  const { run, data } = useStore();
  const ym = data.today.slice(0, 7);
  const usable = products.filter((x) => !x.archived || x.id === a?.product_id);
  const [name, setName] = useState(products.find((x) => x.id === a?.product_id)?.name || '');
  // a beírt / kiválasztott név a törzsből (pontos egyezés); ha nincs ilyen, mentéskor új termék lesz belőle
  const prod = usable.find((x) => normalizeText(x.name) === normalizeText(name));
  const productId = prod?.id || '';
  const [qty, setQty] = useState(a ? fmtQty(a.qty) : '1');
  const [price, setPrice] = useState(digits(a?.price));
  const [billing, setBilling] = useState<Billing | ''>(a?.billing || '');
  const [start, setStart] = useState(a?.start_ym || ym);
  const [end, setEnd] = useState(a?.end_ym || '');
  const [note, setNote] = useState(a?.note || '');
  const [busy, setBusy] = useState(false);
  const months = useMemo(() => Array.from({ length: 50 }, (_, i) => addMonths(ym, i - 12)), [ym]);
  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    const body = {
      partner_key: p.key,
      product_id: productId,
      qty: qty.replace(',', '.'),
      price: price === '' ? null : Number(price),
      billing: billing || null,
      start_ym: start,
      end_ym: end || null,
      note,
    };
    const ok = await run(
      async () => {
        if (!body.product_id) {
          // új termék a törzsbe: a beírt név, ár és ütem (a partner ára egyben a törzsár)
          const r = await api<{ id: string }>('/api/products', {
            method: 'POST',
            body: { name: name.trim(), price: Number(price || 0), billing: billing || 'havi', unit: billing === 'egyszeri' ? 'db' : 'hó' },
          });
          body.product_id = r.id;
          body.price = null;
        }
        await api(a ? `/api/partner-products/${encodeURIComponent(a.id)}` : '/api/partner-products', { method: a ? 'PUT' : 'POST', body });
      },
      `${p.name}: ${name.trim()} ${a ? 'mentve' : prod ? 'hozzárendelve' : 'felvéve a törzsbe és hozzárendelve'}`,
    );
    setBusy(false);
    if (ok) onDone();
  };
  const remove = async () => {
    if (!a || !confirm(`Leveszed ${p.name} partnertől: ${prod?.name || 'ez a tétel'}?`)) return;
    if (await run(() => api(`/api/partner-products/${encodeURIComponent(a.id)}`, { method: 'DELETE' }), 'Levéve a partnerről')) onDone();
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  return (
    <form
      onSubmit={(ev) => (ev.preventDefault(), save())}
      style={{ padding: 16, borderTop: `1px solid ${C.line3}`, background: C.bg2, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Field label="Termék / szolgáltatás" style={{ gridColumn: 'span 2' }}>
          <ProductCombo
            value={name}
            onChange={setName}
            partnerKey={p.key}
            label="Termék vagy szolgáltatás keresése a törzsben"
            placeholder="Gépelj: a törzsből választ, vagy új nevet ír be"
            onPick={(x) => {
              setName(x.product.name);
              if (!a) setQty(fmtQty(x.qty));
            }}
            style={sel}
          />
          {name.trim() && !prod && <span style={{ font: `500 12.5px ${FONT}`, color: C.offer }}>Új tétel: mentéskor felkerül a törzsbe is.</span>}
          {prod && availableOf(prod, data.partnerProducts || []) !== null && (
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
              Elérhető: {fmt(availableOf(prod, data.partnerProducts || [])!)} {prod.unit}
            </span>
          )}
        </Field>
        <Field label={`Mennyiség (${prod?.unit || 'db'})`}>
          <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d,.]/g, ''))} inputMode="decimal" style={sel} />
        </Field>
        <Field label={`Egyedi nettó ár (üres: ${prod ? money(prod.price, prod.currency) : 'törzsár'})`}>
          <MoneyInput value={price} onChange={setPrice} placeholder="törzsár" style={sel} />
        </Field>
        <Field label="Számlázás">
          <select value={billing} onChange={(e) => setBilling(e.target.value as Billing | '')} style={sel}>
            <option value="">A törzs szerint ({prod ? BILLING_LABEL[prod.billing] : '–'})</option>
            {BILLINGS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Első számlázás hónapja">
          <select value={start} onChange={(e) => setStart(e.target.value)} style={sel}>
            {[...new Set([start, ...months])].sort().map((m) => (
              <option key={m} value={m}>
                {monthLong(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Utolsó hónap">
          <select value={end} onChange={(e) => setEnd(e.target.value)} style={sel}>
            <option value="">Folyamatos (nincs vége)</option>
            {[...new Set([...(end ? [end] : []), ...months.filter((m) => m >= start)])].sort().map((m) => (
              <option key={m} value={m}>
                {monthLong(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Megjegyzés (a számlára / belső)" style={{ gridColumn: 'span 2' }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} style={sel} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className={busy ? 'is-loading' : undefined}
          style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '10px 20px', font: `600 14px ${FONT}`, cursor: 'pointer' }}
        >
          {a ? 'Mentés' : 'Hozzárendelés'}
        </button>
        <Pill small onClick={onDone}>
          Mégse
        </Pill>
        {a && (
          <button
            type="button"
            onClick={remove}
            style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: C.neg, font: `600 14px ${FONT}`, cursor: 'pointer' }}
          >
            Levétel a partnerről
          </button>
        )}
      </div>
    </form>
  );
}

export function PartnerProfileForm({ p, compact }: { p: PartnerStat; compact?: boolean }) {
  const { data, run, canEdit } = useStore();
  const saved: PartnerProfile = data.partnerProfiles?.[p.key] || emptyProfile();
  const [v, setV] = useState<PartnerProfile>(saved);
  const save = (over: Partial<PartnerProfile> = {}) => {
    const next = { ...v, ...over };
    if (!canEdit || JSON.stringify(next) === JSON.stringify(saved)) return;
    run(() => api(`/api/partner-profile/${encodeURIComponent(p.key)}`, { method: 'PUT', body: next }), `${p.name}: számlázási adatok mentve`);
  };
  const missing = [
    !v.company && 'cégnév',
    !(v.zip && v.city && v.address) && 'cím',
    !(v.billing_email || v.email) && 'e-mail',
    !p.info?.tax_number && 'adószám',
  ].filter(Boolean);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ font: `700 19px ${FONT_H}`, color: C.navy, flex: 1 }}>Számlázási adatok</b>
        <span style={{ font: `400 13px ${FONT}`, color: missing.length ? C.neg : C.inc }}>
          {missing.length ? `Hiányzik: ${missing.join(', ')}` : 'Minden adat megvan a számlához'}
        </span>
      </div>
      <div style={{ ...card, padding: 16, display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {PROFILE_FIELDS.map(([k, label, max]) => (
          <Field key={k} label={label} style={k === 'company' || k === 'address' ? { gridColumn: compact ? undefined : 'span 2' } : undefined}>
            <input
              value={v[k]}
              maxLength={max}
              disabled={!canEdit}
              type={k.includes('email') ? 'email' : 'text'}
              onChange={(e) => setV({ ...v, [k]: e.target.value })}
              onBlur={() => save()}
              style={{ ...inputStyle, height: 42 }}
            />
          </Field>
        ))}
        <Field label="Fizetési határidő (nap)">
          <input
            value={v.pay_days ?? ''}
            inputMode="numeric"
            disabled={!canEdit}
            placeholder="pl. 8"
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, '').slice(0, 3);
              setV({ ...v, pay_days: d === '' ? null : Number(d) });
            }}
            onBlur={() => save()}
            style={{ ...inputStyle, height: 42 }}
          />
        </Field>
        <div style={{ ...eyebrow, gridColumn: '1 / -1', textTransform: 'none', letterSpacing: 0, font: `400 12.5px ${FONT}` }}>
          Adószám: <b style={{ color: C.navy }}>{p.info?.tax_number || 'nincs megadva'}</b> (a Beállítások fülön szerkeszthető) · a mezők elhagyásakor
          automatikusan mentődik
        </div>
      </div>
    </section>
  );
}

/** rövid kártya a partnertörzs jobb oldali paneljébe: aktív szolgáltatások + mostani számlázandó összeg */
export function PartnerServicesSummary({ p, onOpen }: { p: PartnerStat; onOpen: () => void }) {
  const { data } = useStore();
  const ym = data.today.slice(0, 7);
  const products = data.products || [];
  const rows = (data.partnerProducts || []).filter((a) => a.partner_key === p.key && (!a.end_ym || a.end_ym >= ym));
  const now = billablesFor(ym, rows, products);
  const byId = new Map(products.map((x) => [x.id, x]));
  return (
    <div style={{ padding: '14px 0', borderTop: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...eyebrow, flex: 1 }}>Szolgáltatások, termékek</span>
        <Pill small onClick={onOpen}>
          Kezelés ›
        </Pill>
      </div>
      {!rows.length && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Nincs hozzárendelt szolgáltatás.</span>}
      {rows.map((a) => {
        const pr = byId.get(a.product_id);
        const e = effective(a, pr);
        return (
          <div
            key={a.id}
            style={{ display: 'flex', gap: 8, font: `400 13.5px ${FONT}`, color: C.ink, padding: '6px 10px', borderRadius: R.md, background: C.bg }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pr?.name || 'Törölt termék'} · {BILLING_LABEL[e.billing].toLowerCase()}
            </span>
            <b style={{ fontVariantNumeric: 'tabular-nums', color: C.navy }}>{money(e.net, pr?.currency)}</b>
          </div>
        );
      })}
      {now.length > 0 && (
        <span style={{ font: `600 13px ${FONT}`, color: C.inc }}>
          {monthLong(ym)}: számlázandó nettó {money(now.reduce((s, l) => s + l.net, 0))}
        </span>
      )}
    </div>
  );
}
