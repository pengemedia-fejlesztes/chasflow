// Partner adatlap · „Számlázandó szolgáltatások, termékek” (látványterv, 2026-11-14): a partnerhez rendelt termékek /
// szolgáltatások kártyánként. A kártya lenyitva szerkeszthető, minden változás azonnal mentődik (Visszavonás: a lenyitáskori
// állapot). A havi rácson látszik, melyik hónapban lesz számla – kattintással egy-egy hónap kihagyható.
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BILLING_LABEL, billableIn, billablesFor, effective, monthlyValue, nextBilling, type Billing, type PartnerProduct, type Product } from '../../shared/catalog';
import { normalizeText } from '../../shared/categories';
import { addMonths, fmt, monthLong } from '../../shared/model';
import type { PartnerStat } from '../../shared/partners';
import { api } from './api';
import { MoneyInput } from './PartnerModal';
import { ProductCombo } from './ProductCombo';
import { useStore } from './store';
import { C, FONT, FONT_H, R, inputStyle } from './ui';

const money = (v: number, cur = 'HUF') => `${fmt(v)} ${cur === 'HUF' ? 'Ft' : cur}`;
const short = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace('.', ',')}M` : `${Math.round(v / 1000)}e`);
const MON = ['J', 'F', 'M', 'Á', 'M', 'J', 'J', 'A', 'Sz', 'O', 'N', 'D'];
const BILL_OPTS: [Billing, string][] = [
  ['havi', 'Havonta'],
  ['negyedeves', 'Negyedévente'],
  ['felevi', 'Félévente'],
  ['eves', 'Évente'],
  ['egyszeri', 'Egyszeri'],
];
const per: Record<Billing, string> = { havi: 'havonta', negyedeves: 'negyedévente', felevi: 'félévente', eves: 'évente', egyszeri: 'egyszer' };
const fromLabel = (ym: string) => monthLong(ym).replace(/(\S+)$/, (m) => m + (/[aáoóuú]\S*$/i.test(m) ? 'tól' : 'től'));

export function PartnerServices({ p, compact }: { p: PartnerStat; compact?: boolean }) {
  const { data, canEdit, run } = useStore();
  const products = data.products || [];
  const byId = useMemo(() => new Map(products.map((x) => [x.id, x])), [products]);
  const rows = (data.partnerProducts || []).filter((a) => a.partner_key === p.key);
  const ym = data.today.slice(0, 7);
  const active = rows.filter((a) => !a.end_ym || a.end_ym >= ym);
  const ended = rows.filter((a) => a.end_ym && a.end_ym < ym);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const monthly = active.reduce((s, a) => {
    const e = effective(a, byId.get(a.product_id));
    return s + monthlyValue(e.net, e.billing);
  }, 0);
  const nowSum = billablesFor(ym, rows, products).reduce((s, l) => s + l.net, 0);
  const next12 = Array.from({ length: 12 }, (_, i) => addMonths(ym, i)).reduce((s, m) => s + billablesFor(m, rows, products).reduce((x, l) => x + l.net, 0), 0);

  // új hozzárendelés: a törzsből választott, vagy új névvel (akkor a törzsbe is felkerül)
  const [q, setQ] = useState('');
  const add = (prod: Product | null, name: string) => {
    const n = name.trim();
    if (!n) return;
    let newId = '';
    run(async () => {
      let pid = prod?.id;
      if (!pid) {
        const r = await api<{ id: string }>('/api/products', { method: 'POST', body: { name: n, price: 0, billing: 'havi', unit: 'hó' } });
        pid = r.id;
      }
      const r = await api<{ id: string }>('/api/partner-products', { method: 'POST', body: { partner_key: p.key, product_id: pid, qty: 1, start_ym: ym } });
      newId = r.id;
    }, `${p.name}: ${n} hozzárendelve`).then((ok) => {
      if (ok) {
        setQ('');
        setOpen(newId);
      }
    });
  };

  const box: CSSProperties = { border: `1px solid ${C.line}`, borderRadius: R.lg, background: '#fff', padding: '8px 14px', textAlign: 'right', minWidth: 130 };
  const kpi = (l: string, v: number) => (
    <div style={box}>
      <div style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted }}>{l}</div>
      <b style={{ font: `700 17px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{money(v)}</b>
    </div>
  );
  const list = [...active, ...(all ? ended : [])];
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <b style={{ font: `700 20px ${FONT_H}`, color: C.navy }}>Számlázandó szolgáltatások, termékek</b>
          <div style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
            {active.length} aktív{ended.length ? ` · ${ended.length} lezárt` : ''}
          </div>
        </div>
        {!compact && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {kpi('Havi átlag nettó', monthly)}
            {kpi(monthLong(ym), nowSum)}
            {kpi('Következő 12 hó', next12)}
          </div>
        )}
      </div>
      {data.catalogError && <span style={{ color: C.neg, font: `500 13px ${FONT}` }}>{data.catalogError}</span>}
      {list.map((a) => (
        <ServiceCard
          key={a.id}
          p={p}
          a={a}
          product={byId.get(a.product_id)}
          ym={ym}
          open={open === a.id}
          onToggle={() => setOpen(open === a.id ? null : a.id)}
          canEdit={canEdit}
        />
      ))}
      {ended.length > 0 && (
        <button type="button" onClick={() => setAll(!all)} style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', color: C.blueDark, font: `600 13px ${FONT}`, cursor: 'pointer' }}>
          {all ? 'Lezártak elrejtése' : `Lezártak is (${ended.length})`}
        </button>
      )}
      {canEdit && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            border: `1.5px dashed ${C.line2}`,
            borderRadius: R.lg,
            padding: '6px 8px 6px 16px',
            background: '#fff',
          }}
        >
          <b style={{ font: `600 14.5px ${FONT}`, color: C.blueDark, whiteSpace: 'nowrap' }}>+ Szolgáltatás / termék hozzárendelése</b>
          <div style={{ flex: 1, minWidth: 0 }} onKeyDown={(e) => e.key === 'Enter' && q.trim() && add(products.find((x) => normalizeText(x.name) === normalizeText(q)) || null, q)}>
            <ProductCombo
              value={q}
              onChange={setQ}
              partnerKey={p.key}
              label="Szolgáltatás vagy termék keresése a törzsben"
              placeholder="keresés a törzsben… (vagy új név + Enter)"
              onPick={(x) => add(x.product, x.product.name)}
              style={{ ...inputStyle, height: 38, border: 0, textAlign: 'right', background: 'transparent' }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function ServiceCard({
  p,
  a,
  product,
  ym,
  open,
  onToggle,
  canEdit,
}: {
  p: PartnerStat;
  a: PartnerProduct;
  product?: Product;
  ym: string;
  open: boolean;
  onToggle: () => void;
  canEdit: boolean;
}) {
  const e = effective(a, product);
  const next = nextBilling(a, e.billing, ym);
  const cur = product?.currency || 'HUF';
  const name = product?.name || 'Törölt termék';
  const endTxt = a.end_ym ? (a.end_ym === a.start_ym ? 'csak egyszer' : `${monthLong(a.end_ym)}-ig`) : 'folyamatosan';
  return (
    <div style={{ border: `1.5px solid ${open ? C.blue : C.line}`, borderRadius: R.lg, background: '#fff', overflow: 'hidden' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), onToggle())}
        className="hov-row"
        style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', cursor: 'pointer' }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <b style={{ font: `700 17px ${FONT}`, color: C.navy, overflowWrap: 'anywhere' }}>{name}</b>
          <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
            {BILLING_LABEL[e.billing]}
            {a.billing ? '' : ' (törzs szerint)'} · {fromLabel(a.start_ym)} · {endTxt}
            {next ? ` · következő számla: ${monthLong(next)}` : ' · nincs több számla'}
          </span>
        </span>
        <span style={{ textAlign: 'right', display: 'flex', flexDirection: 'column' }}>
          <b style={{ font: `800 22px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money(e.net, cur)}</b>
          <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, whiteSpace: 'nowrap' }}>
            {fmt(a.qty)} × {money(e.price, cur)} · {per[e.billing]}
          </span>
        </span>
        <span style={{ color: C.muted, transform: open ? 'none' : 'rotate(180deg)', transition: 'transform .2s' }}>▲</span>
      </div>
      {open && <ServiceEditor key={a.id} p={p} a={a} product={product} ym={ym} canEdit={canEdit} />}
    </div>
  );
}

function ServiceEditor({ p, a, product, ym, canEdit }: { p: PartnerStat; a: PartnerProduct; product?: Product; ym: string; canEdit: boolean }) {
  const { run, data } = useStore();
  const products = data.products || [];
  // Visszavonás: a lenyitáskori állapot
  const snap = useRef(a);
  const e = effective(a, product);
  const cur = product?.currency || 'HUF';
  const [name, setName] = useState(product?.name || '');
  const [custom, setCustom] = useState(a.price !== null);
  const [price, setPrice] = useState(String(Math.round(a.price ?? product?.price ?? 0)));
  const [note, setNote] = useState(a.note || '');
  const put = (patch: Record<string, unknown>, msg = 'Mentve') =>
    canEdit && run(() => api(`/api/partner-products/${encodeURIComponent(a.id)}`, { method: 'PUT', body: patch }), `${p.name}: ${msg}`);

  const swap = (prod: Product | null, n: string) => {
    const nn = n.trim();
    if (!nn || (prod && prod.id === a.product_id)) return;
    run(async () => {
      let pid = prod?.id;
      if (!pid) pid = (await api<{ id: string }>('/api/products', { method: 'POST', body: { name: nn, price: e.price, billing: e.billing, unit: product?.unit || 'db' } })).id;
      await api(`/api/partner-products/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { product_id: pid } });
    }, `${p.name}: szolgáltatás cserélve – ${nn}`);
  };

  // számlázási rács: a kezdő évtől két év (vagy a záró hónap évéig)
  const y0 = Number(a.start_ym.slice(0, 4));
  const y1 = Math.max(y0 + 1, a.end_ym ? Math.min(Number(a.end_ym.slice(0, 4)), y0 + 4) : y0 + 1);
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const skip = new Set(a.skip || []);
  const plain = { ...a, skip: [] };
  const months = years.flatMap((y) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`));
  const billed = months.filter((m) => billableIn(a, e.billing, m));
  const toggleSkip = (m: string) => {
    const n = new Set(skip);
    if (n.has(m)) n.delete(m);
    else n.add(m);
    put({ skip: [...n] }, `${monthLong(m)} ${n.has(m) ? 'kihagyva' : 'visszavéve'}`);
  };
  const endMode = !a.end_ym ? 'cont' : a.end_ym === a.start_ym ? 'once' : a.end_ym === addMonths(a.start_ym, 11) ? 'y1' : a.end_ym === addMonths(a.start_ym, 23) ? 'y2' : 'other';
  const setEnd = (m: string) =>
    put({ end_ym: m === 'cont' ? null : m === 'once' ? a.start_ym : m === 'y1' ? addMonths(a.start_ym, 11) : addMonths(a.start_ym, 23) }, 'utolsó számla módosítva');
  const setStart = (d: number) => {
    const s = addMonths(a.start_ym, d);
    // a futamidő hossza megmarad
    const end = a.end_ym ? addMonths(a.end_ym, d) : null;
    put({ start_ym: s, end_ym: end }, `első számla: ${monthLong(s)}`);
  };
  const undo = () => {
    const s = snap.current;
    put({ product_id: s.product_id, qty: s.qty, price: s.price, billing: s.billing, start_ym: s.start_ym, end_ym: s.end_ym, note: s.note || '', skip: s.skip || [], note_internal: s.note_internal || 0 }, 'visszavonva');
    setName(products.find((x) => x.id === s.product_id)?.name || '');
    setCustom(s.price !== null);
    setPrice(String(Math.round(s.price ?? product?.price ?? 0)));
    setNote(s.note || '');
  };
  const remove = () => {
    if (!confirm(`Leveszed ${p.name} partnertől: ${product?.name || 'ez a tétel'}?`)) return;
    run(() => api(`/api/partner-products/${encodeURIComponent(a.id)}`, { method: 'DELETE' }), 'Levéve a partnerről');
  };

  const lbl: CSSProperties = { font: `600 14px ${FONT}`, color: C.navy };
  return (
    <div style={{ borderTop: `1px solid ${C.line3}`, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 190px', gap: 14 }}>
        <Lab title="Termék / szolgáltatás">
          <ProductCombo
            value={name}
            onChange={setName}
            partnerKey={p.key}
            label="Termék vagy szolgáltatás cseréje"
            placeholder="keresés a törzsben vagy új név"
            onPick={(x) => (setName(x.product.name), swap(x.product, x.product.name))}
            style={{ ...inputStyle, height: 46, font: `500 15.5px ${FONT}` }}
          />
          <span style={{ font: `400 12px ${FONT}`, color: C.muted }} onMouseDown={(ev) => ev.preventDefault()}>
            {normalizeText(name) !== normalizeText(product?.name || '') && name.trim() ? (
              <button type="button" onClick={() => swap(products.find((x) => normalizeText(x.name) === normalizeText(name)) || null, name)} style={linkBtn}>
                „{name.trim()}” mentése (csere)
              </button>
            ) : (
              'csere: kezdj gépelni, és válassz a törzsből'
            )}
          </span>
        </Lab>
        <Lab title="Mennyiség">
          <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 44px', border: `1px solid ${C.line2}`, borderRadius: R.md, height: 46, overflow: 'hidden' }}>
            <button type="button" disabled={!canEdit || a.qty <= 1} onClick={() => put({ qty: Math.max(1, a.qty - 1) }, 'mennyiség')} style={stepBtn}>
              –
            </button>
            <b style={{ display: 'grid', placeItems: 'center', font: `700 15px ${FONT}`, color: C.navy, borderLeft: `1px solid ${C.line3}`, borderRight: `1px solid ${C.line3}` }}>
              {fmt(a.qty)} {product?.unit || 'db'}
            </b>
            <button type="button" disabled={!canEdit} onClick={() => put({ qty: a.qty + 1 }, 'mennyiség')} style={stepBtn}>
              +
            </button>
          </div>
        </Lab>
      </div>

      <Lab title="Nettó egységár">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Pills
            value={custom ? 'c' : 't'}
            options={[
              ['t', `Törzsár · ${money(product?.price || 0, cur)}`],
              ['c', 'Egyedi ár'],
            ]}
            onChange={(v) => {
              if (!canEdit) return;
              setCustom(v === 'c');
              if (v === 't') put({ price: null }, 'törzsár');
              else put({ price: Number(price || product?.price || 0) }, 'egyedi ár');
            }}
          />
          {custom ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 160 }}>
                <MoneyInput value={price} onChange={setPrice} placeholder="nettó ár" style={{ ...inputStyle, height: 40 }} />
              </span>
              <button type="button" onClick={() => put({ price: Number(price || 0) }, `egyedi ár ${money(Number(price || 0), cur)}`)} style={linkBtn}>
                mentés
              </button>
              <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>nem követi a törzsárat</span>
            </span>
          ) : (
            <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
              a törzsből: <b style={{ color: C.navy }}>{money(product?.price || 0, cur)}</b> — ha a törzsár változik, ez is követi
            </span>
          )}
        </div>
      </Lab>

      <Lab title="Számlázás">
        <Pills
          value={a.billing || ''}
          options={[['', `Törzs szerint (${(BILLING_LABEL[product?.billing || 'havi'] || '').toLowerCase()})`], ...BILL_OPTS] as [string, string][]}
          onChange={(v) => put({ billing: v || null }, `számlázás: ${v ? BILLING_LABEL[v as Billing] : 'törzs szerint'}`)}
        />
      </Lab>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={lbl}>Első számla:</span>
        <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${C.line2}`, borderRadius: R.md, height: 42 }}>
          <button type="button" disabled={!canEdit} onClick={() => setStart(-1)} style={stepBtn} aria-label="Egy hónappal korábban">
            ‹
          </button>
          <b style={{ minWidth: 150, textAlign: 'center', font: `700 15px ${FONT}`, color: C.navy }}>{monthLong(a.start_ym)}</b>
          <button type="button" disabled={!canEdit} onClick={() => setStart(1)} style={stepBtn} aria-label="Egy hónappal később">
            ›
          </button>
        </div>
        <span style={lbl}>· utolsó:</span>
        <Pills
          value={endMode}
          options={[
            ['cont', 'Folyamatos'],
            ['y1', '1 év'],
            ['y2', '2 év'],
            ['once', 'Csak az első'],
            ...(endMode === 'other' ? ([['other', `${monthLong(a.end_ym!)}-ig`]] as [string, string][]) : []),
          ]}
          onChange={(v) => v !== 'other' && setEnd(v)}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={lbl}>Számlázási hónapok</span>
          <span style={{ font: `400 13px ${FONT}`, color: C.muted, flex: 1 }}>
            · {billed.length} számla {years[0]}–{years[years.length - 1]}-ben
          </span>
          <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>kattintással kihagyható</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '48px repeat(12, minmax(0,1fr))', gap: 5, alignItems: 'center' }}>
          <span />
          {MON.map((m, i) => (
            <span key={i} style={{ textAlign: 'center', font: `500 11.5px ${FONT}`, color: C.muted }}>
              {m}
            </span>
          ))}
          {years.map((y) => (
            <Row key={y} y={y}>
              {Array.from({ length: 12 }, (_, i) => {
                const m = `${y}-${String(i + 1).padStart(2, '0')}`;
                const would = billableIn(plain, e.billing, m);
                const skipped = would && skip.has(m);
                const now = m === ym;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={!canEdit || !would}
                    onClick={() => toggleSkip(m)}
                    title={would ? (skipped ? `${monthLong(m)}: kihagyva – kattints a visszavételhez` : `${monthLong(m)}: számla lesz – kattints a kihagyáshoz`) : monthLong(m)}
                    style={{
                      height: 52,
                      borderRadius: 9,
                      border: now ? `2.5px solid ${C.navy}` : would ? `1.5px ${skipped ? 'dashed' : 'solid'} ${skipped ? C.neg : C.blue}` : `1px dashed ${C.line3}`,
                      background: would && !skipped ? C.bg2 : m < a.start_ym ? '#fff' : C.bg3,
                      cursor: canEdit && would ? 'pointer' : 'default',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 1,
                      padding: 0,
                    }}
                  >
                    {would && (
                      <>
                        <b style={{ font: `700 13px ${FONT}`, color: skipped ? C.neg : C.navy, textDecoration: skipped ? 'line-through' : undefined }}>{short(e.net)}</b>
                        <span style={{ font: `500 10.5px ${FONT}`, color: skipped ? C.neg : C.blueDark }}>{skipped ? 'kihagyva' : 'számla'}</span>
                      </>
                    )}
                  </button>
                );
              })}
            </Row>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', font: `400 12.5px ${FONT}`, color: C.muted }}>
          <Legend b={`1.5px solid ${C.blue}`} bg={C.bg2} t="számla lesz" />
          <Legend b={`1.5px dashed ${C.neg}`} bg="#fff" t="kihagyva" />
          <Legend b={`1px dashed ${C.line3}`} bg={C.bg3} t="nincs számla" />
          <Legend b={`2.5px solid ${C.navy}`} bg="#fff" t="most" />
        </div>
      </div>

      <Lab title="Megjegyzés">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pills
            value={a.note_internal ? 'b' : 's'}
            options={[
              ['s', 'A számlára'],
              ['b', 'Belső'],
            ]}
            onChange={(v) => put({ note_internal: v === 'b' ? 1 : 0 }, v === 'b' ? 'belső megjegyzés' : 'megjegyzés a számlára')}
          />
          <input
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            onBlur={() => note !== (a.note || '') && put({ note }, 'megjegyzés')}
            onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
            disabled={!canEdit}
            maxLength={1000}
            placeholder={a.note_internal ? 'csak nekünk látszik' : 'megjelenik a számlán, pl. „domain: ügyfel.hu”'}
            style={{ ...inputStyle, height: 44, flex: 1, minWidth: 220 }}
          />
        </div>
      </Lab>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${C.line3}`, paddingTop: 12 }}>
        <i style={{ width: 8, height: 8, borderRadius: 999, background: C.blue, display: 'inline-block' }} />
        <span style={{ font: `400 13px ${FONT}`, color: C.muted, flex: 1 }}>
          Minden változás azonnal mentődik ·{' '}
          <button type="button" disabled={!canEdit} onClick={undo} style={linkBtn}>
            Visszavonás
          </button>
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={remove}
            style={{ border: `1px solid ${C.negLight}`, borderRadius: 999, background: '#fff', color: C.neg, padding: '8px 16px', font: `600 13.5px ${FONT}`, cursor: 'pointer' }}
          >
            Levétel a partnerről
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ y, children }: { y: number; children: ReactNode }) {
  return (
    <>
      <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>{y}</b>
      {children}
    </>
  );
}

function Lab({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ font: `600 14px ${FONT}`, color: C.navy }}>{title}</span>
      {children}
    </div>
  );
}

function Legend({ b, bg, t }: { b: string; bg: string; t: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <i style={{ width: 13, height: 13, borderRadius: 4, border: b, background: bg, display: 'inline-block', boxSizing: 'border-box' }} />
      {t}
    </span>
  );
}

function Pills<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="group" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 2, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3 }}>
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          style={{
            border: 0,
            borderRadius: 999,
            padding: '8px 16px',
            background: v === value ? C.navy : 'transparent',
            color: v === value ? '#fff' : C.ink,
            font: `${v === value ? 600 : 500} 14px ${FONT}`,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

const stepBtn: CSSProperties = { border: 0, background: '#fff', color: C.navy, font: `700 18px ${FONT}`, cursor: 'pointer', width: 44, height: '100%' };
const linkBtn: CSSProperties = { border: 0, background: 'transparent', padding: 0, color: C.blueDark, font: `600 13px ${FONT}`, cursor: 'pointer' };
