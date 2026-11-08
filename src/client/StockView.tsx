// Raktárkészlet: termékenként raktári, lefoglalt és elérhető mennyiség; szűrés raktárra, termékcsoportra, termékre;
// sor lenyitva raktáranként, a foglalások (partnerek) és a mozgások; bevételezés, kiadás, leltár, átvezetés; CSV-export.
import { Fragment, useMemo, useState, type CSSProperties } from 'react';
import { normalizeText } from '../shared/categories';
import { fmt } from '../shared/model';
import { MOVE_LABEL, inventory, toCsv, type Inventory, type MoveKind } from '../shared/stock';
import { api } from './api';
import { useAllPartners } from './PartnerCard';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Modal, Pill, card, inputStyle, dateTime } from './ui';

/** termékenkénti készlet (raktári, lefoglalt, elérhető) a betöltött adatokból */
export function useInventory(): Map<string, Inventory> {
  const { data } = useStore();
  return useMemo(
    () => inventory(data.products || [], data.stockLevels || [], data.partnerProducts || [], data.today.slice(0, 7)),
    [data.products, data.stockLevels, data.partnerProducts, data.today],
  );
}

/** elérhető mennyiség, vagy null ha a terméknek nincs készletnyilvántartása */
export const availOf = (inv: Map<string, Inventory>, id: string) => {
  const x = inv.get(id);
  return x && x.tracked ? x.available : null;
};

const q = (n: number) => (Number.isInteger(n) ? fmt(n) : String(n).replace('.', ','));
const BLUE = '#DCEBFA',
  YELLOW = '#FBF0CC',
  GREEN = '#D9EFDF',
  RED = '#F8DCD5';

export function StockView() {
  const { data, canEdit } = useStore();
  const inv = useInventory();
  const products = (data.products || []).filter((p) => !p.archived);
  const whs = (data.warehouses || []).filter((w) => !w.archived);
  const [wh, setWh] = useState('');
  const [grp, setGrp] = useState('');
  const [search, setSearch] = useState('');
  const [onlyTracked, setOnlyTracked] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [move, setMove] = useState<{ product?: string; kind: MoveKind } | null>(null);
  const [whEdit, setWhEdit] = useState(false);
  const groups = [...new Set(products.map((p) => p.grp || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'hu'));
  const nq = normalizeText(search);
  const rows = products
    .filter((p) => !grp || (grp === '-' ? !p.grp : p.grp === grp))
    .filter((p) => !nq || normalizeText(`${p.name} ${p.sku || ''}`).includes(nq))
    .filter((p) => !onlyTracked || inv.get(p.id)?.tracked)
    .map((p) => {
      const x = inv.get(p.id)!;
      const onHand = wh ? x.byWarehouse[wh] || 0 : x.onHand;
      return { p, x, onHand, available: Math.round((onHand - x.reserved) * 1000) / 1000 };
    })
    .filter((r) => !wh || r.x.byWarehouse[wh] !== undefined || r.x.reserved)
    .sort((a, b) => a.p.name.localeCompare(b.p.name, 'hu'));
  const toggle = (id: string) => {
    const n = new Set(open);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setOpen(n);
  };
  const exportCsv = () => {
    const csv = toCsv([
      ['Termék', 'Termékcsoport', 'Cikkszám', 'Raktár', 'Raktári mennyiség', 'Lefoglalt mennyiség', 'Elérhető mennyiség', 'Egység'],
      ...rows.map((r) => [
        r.p.name,
        r.p.grp || '',
        r.p.sku || '',
        wh ? whs.find((w) => w.id === wh)?.name || '' : 'Összes',
        r.onHand,
        r.x.reserved,
        r.available,
        r.p.unit,
      ]),
    ]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `raktarkeszlet-${data.today}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  const th: CSSProperties = { font: `600 13px ${FONT}`, color: C.navy, padding: '12px 14px' };
  const COLS = '52px minmax(180px,1.6fr) minmax(120px,1fr) 150px 150px 150px';
  return (
    <div style={{ padding: '24px 28px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, font: `800 32px/1.05 ${FONT_H}`, color: C.navy }}>Raktárkészlet</h1>
          <p style={{ margin: '8px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted }}>
            Raktári mennyiség − lefoglalt (partnerekhez rendelt, még nem teljesített) = elérhető. A termékek a „Termékek, szolgáltatások” törzsből jönnek.
          </p>
        </div>
        {canEdit && (
          <>
            <Pill onClick={() => setWhEdit(true)}>Raktárak</Pill>
            <Pill onClick={() => setMove({ kind: 'korrekcio' })}>Leltár</Pill>
            <Pill onClick={() => setMove({ kind: 'kiadas' })}>− Kiadás</Pill>
            <button
              type="button"
              className="hov-primary"
              onClick={() => setMove({ kind: 'bevet' })}
              style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '12px 22px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
            >
              + Bevételezés
            </button>
          </>
        )}
      </div>
      {data.stockError && <div style={{ ...card, padding: 14, color: C.neg, font: `500 14px ${FONT}` }}>{data.stockError}</div>}

      <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <Field label="Raktár">
            <select value={wh} onChange={(e) => setWh(e.target.value)} style={sel}>
              <option value="">Mind</option>
              {whs.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Termékcsoport">
            <select value={grp} onChange={(e) => setGrp(e.target.value)} style={sel}>
              <option value="">Mind</option>
              {groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
              <option value="-">Csoport nélkül</option>
            </select>
          </Field>
          <Field label="Termék">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Név vagy cikkszám…" style={sel} />
          </Field>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, font: `500 13.5px ${FONT}`, color: C.muted }}>
            <input type="checkbox" checked={onlyTracked} onChange={(e) => setOnlyTracked(e.target.checked)} /> csak készletnyilvántartott (termék típus, vagy
            volt készletmozgása)
          </label>
          <span style={{ marginLeft: 'auto', font: `400 13.5px ${FONT}`, color: C.muted }}>{rows.length} tétel</span>
        </div>

        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflowX: 'auto' }}>
          <div style={{ minWidth: 820 }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, borderBottom: `1px solid ${C.line}`, alignItems: 'center' }}>
              <span style={{ padding: '8px 8px' }}>
                <button
                  type="button"
                  onClick={exportCsv}
                  aria-label="Exportálás CSV-be (Excel)"
                  title="Exportálás CSV-be (Excel)"
                  style={{
                    width: 36,
                    height: 36,
                    border: 0,
                    borderRadius: 6,
                    background: '#2E9E4F',
                    color: '#fff',
                    font: `700 12px ${FONT}`,
                    cursor: 'pointer',
                  }}
                >
                  XLS
                </button>
              </span>
              <span style={th}>Termék</span>
              <span style={th}>Termékcsoport</span>
              <span style={{ ...th, textAlign: 'right' }}>Raktári mennyiség</span>
              <span style={{ ...th, textAlign: 'right' }}>Lefoglalt mennyiség</span>
              <span style={{ ...th, textAlign: 'right' }}>Elérhető mennyiség</span>
            </div>
            {!rows.length && (
              <div className="empty-state" style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>
                Nincs készletnyilvántartott termék. Állítsd a termék típusát „Termék”-re, vagy rögzíts bevételezést.
              </div>
            )}
            {rows.map((r) => {
              const isOpen = open.has(r.p.id);
              const cell = (bg: string, v: number, bold?: boolean): CSSProperties => ({
                background: bg,
                textAlign: 'right',
                padding: '14px',
                font: `${bold ? 700 : 500} 15px ${FONT}`,
                color: v < 0 ? C.neg : C.ink,
                fontVariantNumeric: 'tabular-nums',
              });
              return (
                <Fragment key={r.p.id}>
                  <div style={{ display: 'grid', gridTemplateColumns: COLS, borderTop: `1px solid ${C.line3}`, alignItems: 'stretch' }}>
                    <span style={{ padding: '8px', display: 'grid', placeItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => toggle(r.p.id)}
                        aria-expanded={isOpen}
                        aria-label={`${r.p.name} részletei`}
                        style={{
                          width: 34,
                          height: 34,
                          border: 0,
                          borderRadius: 6,
                          background: '#7C8288',
                          color: '#fff',
                          font: `600 15px ${FONT}`,
                          cursor: 'pointer',
                        }}
                      >
                        {isOpen ? '⌄' : '›'}
                      </button>
                    </span>
                    <span style={{ padding: '14px', font: `500 15px ${FONT}`, color: C.ink, minWidth: 0 }}>
                      {r.p.name}
                      {r.p.sku ? <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}> · {r.p.sku}</span> : null}
                    </span>
                    <span style={{ padding: '14px', font: `400 14.5px ${FONT}`, color: r.p.grp ? C.ink : C.faint }}>{r.p.grp || '–'}</span>
                    <span style={cell(BLUE, r.onHand)}>
                      {q(r.onHand)} {r.p.unit}
                    </span>
                    <span style={cell(YELLOW, r.x.reserved)}>
                      {q(r.x.reserved)} {r.p.unit}
                    </span>
                    <span style={{ ...cell(r.available < 0 ? RED : GREEN, r.available, true) }}>
                      {q(r.available)} {r.p.unit}
                    </span>
                  </div>
                  {isOpen && <StockDetail productId={r.p.id} inv={r.x} onMove={(kind) => setMove({ product: r.p.id, kind })} />}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      {move && <MoveDialog init={move} onClose={() => setMove(null)} />}
      {whEdit && <WarehouseDialog onClose={() => setWhEdit(false)} />}
    </div>
  );
}

function StockDetail({ productId, inv, onMove }: { productId: string; inv: Inventory; onMove: (k: MoveKind) => void }) {
  const { data, run, canEdit, openPartner } = useStore();
  const partners = useAllPartners();
  const p = data.products?.find((x) => x.id === productId)!;
  const whName = (id: string) => data.warehouses?.find((w) => w.id === id)?.name || id;
  const moves = (data.stockMoves || []).filter((m) => m.product_id === productId).slice(0, 15);
  const uName = (id: number | null) => data.taskUsers?.find((u) => u.id === id)?.name || '';
  const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 };
  const small: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted };
  return (
    <div
      style={{
        background: C.bg,
        borderTop: `1px solid ${C.line3}`,
        padding: '14px 18px 16px 60px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 18,
      }}
    >
      <div style={box}>
        <span style={small}>Raktáranként</span>
        {!Object.keys(inv.byWarehouse).length && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Még nincs készletmozgás.</span>}
        {Object.entries(inv.byWarehouse).map(([w, n]) => (
          <span key={w} style={{ display: 'flex', font: `400 14px ${FONT}`, color: C.ink }}>
            <span style={{ flex: 1 }}>{whName(w)}</span>
            <b style={{ fontVariantNumeric: 'tabular-nums', color: n < 0 ? C.neg : C.navy }}>
              {q(n)} {p.unit}
            </b>
          </span>
        ))}
        {canEdit && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <Pill small kind="primary" onClick={() => onMove('bevet')}>
              + Bevételezés
            </Pill>
            <Pill small onClick={() => onMove('kiadas')}>
              − Kiadás
            </Pill>
            <Pill small onClick={() => onMove('korrekcio')}>
              Leltár
            </Pill>
            {(data.warehouses || []).filter((w) => !w.archived).length > 1 && (
              <Pill small onClick={() => onMove('atvezetes')}>
                Átvezetés
              </Pill>
            )}
          </div>
        )}
      </div>
      <div style={box}>
        <span style={small}>Lefoglalva ({inv.reservations.length})</span>
        {!inv.reservations.length && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Nincs foglalás.</span>}
        {inv.reservations.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => openPartner(a.partner_key)}
            style={{
              display: 'flex',
              gap: 8,
              border: 0,
              background: 'transparent',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              font: `400 14px ${FONT}`,
              color: C.ink,
            }}
          >
            <span style={{ flex: 1 }} className="partner-link">
              {partners.find((x) => x.key === a.partner_key)?.name || a.partner_key}
            </span>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>
              {q(a.qty)} {p.unit}
            </b>
          </button>
        ))}
      </div>
      <div style={{ ...box, gridColumn: 'span 1' }}>
        <span style={small}>Utolsó mozgások</span>
        {!moves.length && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Nincs mozgás.</span>}
        {moves.map((m) => (
          <span key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', font: `400 13px ${FONT}`, color: C.ink }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {dateTime(m.created_at)} · {MOVE_LABEL[m.kind]} · {whName(m.warehouse_id)}
              {m.note ? ` · ${m.note}` : ''}
              {m.created_by ? <span style={{ color: C.muted }}> · {uName(m.created_by)}</span> : null}
            </span>
            <b style={{ fontVariantNumeric: 'tabular-nums', color: m.qty < 0 ? C.neg : C.inc }}>
              {m.qty > 0 ? '+' : ''}
              {q(m.qty)}
            </b>
            {canEdit && (
              <button
                type="button"
                aria-label="Mozgás törlése"
                title="Mozgás törlése (visszavonás)"
                onClick={() =>
                  confirm('Törlöd ezt a készletmozgást? (átvezetésnél a pár mozgás is törlődik)') &&
                  run(() => api(`/api/stock-moves/${encodeURIComponent(m.id)}`, { method: 'DELETE' }), 'Készletmozgás törölve')
                }
                style={{ border: 0, background: 'transparent', color: C.faint, cursor: 'pointer', font: `600 13px ${FONT}` }}
              >
                ✕
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function MoveDialog({ init, onClose }: { init: { product?: string; kind: MoveKind }; onClose: () => void }) {
  const { data, run } = useStore();
  const partners = useAllPartners();
  const inv = useInventory();
  const products = (data.products || []).filter((p) => !p.archived);
  const whs = (data.warehouses || []).filter((w) => !w.archived);
  const [kind, setKind] = useState<MoveKind>(init.kind);
  const [product, setProduct] = useState(init.product || '');
  const [pq, setPq] = useState(products.find((p) => p.id === init.product)?.name || '');
  const [wh, setWh] = useState(whs[0]?.id || '');
  const [to, setTo] = useState(whs[1]?.id || '');
  const [qty, setQty] = useState('');
  const [partner, setPartner] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const p = products.find((x) => x.id === product) || products.find((x) => normalizeText(x.name) === normalizeText(pq));
  const cur = p ? inv.get(p.id)?.byWarehouse[wh] || 0 : 0;
  const pMatch = partners.find((x) => normalizeText(x.name) === normalizeText(partner));
  const save = async () => {
    if (!p || busy) return;
    setBusy(true);
    const ok = await run(
      () =>
        api('/api/stock-moves', {
          method: 'POST',
          body: { kind, product_id: p.id, warehouse_id: wh, to_warehouse_id: to, qty: qty.replace(',', '.'), partner_key: pMatch?.key || null, note },
        }),
      `${p.name}: ${MOVE_LABEL[kind].toLowerCase()} rögzítve`,
    );
    setBusy(false);
    if (ok) onClose();
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  return (
    <Modal onClose={onClose} width={560} title="Készletmozgás" label="Készletmozgás rögzítése">
      <form onSubmit={(e) => (e.preventDefault(), save())} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 24px 24px' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(MOVE_LABEL) as MoveKind[])
            .filter((k) => k !== 'atvezetes' || whs.length > 1)
            .map((k) => (
              <Pill key={k} small kind={kind === k ? 'primary' : 'light'} onClick={() => setKind(k)}>
                {MOVE_LABEL[k]}
              </Pill>
            ))}
        </div>
        <Field label="Termék">
          <input
            value={pq}
            onChange={(e) => (setPq(e.target.value), setProduct(''))}
            list="cf-stock-products"
            required
            autoFocus={!init.product}
            placeholder="Kezdd gépelni…"
            style={sel}
          />
          <datalist id="cf-stock-products">
            {products.map((x) => (
              <option key={x.id} value={x.name} />
            ))}
          </datalist>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label={kind === 'atvezetes' ? 'Honnan' : 'Raktár'}>
            <select value={wh} onChange={(e) => setWh(e.target.value)} style={sel}>
              {whs.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          {kind === 'atvezetes' ? (
            <Field label="Hová">
              <select value={to} onChange={(e) => setTo(e.target.value)} style={sel}>
                {whs
                  .filter((w) => w.id !== wh)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </select>
            </Field>
          ) : (
            <Field label={kind === 'korrekcio' ? `Leltár szerinti mennyiség (${p?.unit || 'db'})` : `Mennyiség (${p?.unit || 'db'})`}>
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^\d,.]/g, ''))}
                inputMode="decimal"
                required
                autoFocus={!!init.product}
                style={sel}
              />
            </Field>
          )}
        </div>
        {kind === 'atvezetes' && (
          <Field label={`Mennyiség (${p?.unit || 'db'})`}>
            <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d,.]/g, ''))} inputMode="decimal" required style={sel} />
          </Field>
        )}
        {p && (
          <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>
            Jelenleg ebben a raktárban:{' '}
            <b style={{ color: C.navy }}>
              {q(cur)} {p.unit}
            </b>
            {kind === 'korrekcio' && qty !== '' ? ` · különbözet: ${q(Math.round((Number(qty.replace(',', '.')) - cur) * 1000) / 1000)}` : ''}
          </span>
        )}
        {kind === 'kiadas' && (
          <Field label="Partner (kinek adjuk ki, nem kötelező)">
            <input value={partner} onChange={(e) => setPartner(e.target.value)} list="cf-stock-partners" style={sel} />
            <datalist id="cf-stock-partners">
              {partners.map((x) => (
                <option key={x.key} value={x.name} />
              ))}
            </datalist>
          </Field>
        )}
        <Field label="Megjegyzés (pl. szállítólevél, számlaszám)">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} style={sel} />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="submit"
            disabled={busy || !p || qty === ''}
            className={busy ? 'is-loading' : undefined}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '11px 24px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
          >
            Rögzítés
          </button>
          <Pill small onClick={onClose}>
            Mégse
          </Pill>
        </div>
      </form>
    </Modal>
  );
}

function WarehouseDialog({ onClose }: { onClose: () => void }) {
  const { data, run } = useStore();
  const [name, setName] = useState('');
  const whs = data.warehouses || [];
  return (
    <Modal onClose={onClose} width={520} title="Raktárak" label="Raktárak kezelése">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 24px 24px' }}>
        {whs.map((w) => (
          <WhRow key={w.id + w.name + w.archived} id={w.id} name={w.name} archived={!!w.archived} />
        ))}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (name.trim() && (await run(() => api('/api/warehouses', { method: 'POST', body: { name } }), `Új raktár: ${name}`))) setName('');
          }}
          style={{ display: 'flex', gap: 8, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Új raktár neve" style={{ ...inputStyle, height: 40, flex: 1 }} />
          <button
            type="submit"
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '0 18px', font: `600 14px ${FONT}`, cursor: 'pointer' }}
          >
            + Hozzáadás
          </button>
        </form>
      </div>
    </Modal>
  );
}

function WhRow({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const { run } = useStore();
  const [v, setV] = useState(name);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: archived ? 0.55 : 1 }}>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() =>
          v.trim() && v !== name && run(() => api(`/api/warehouses/${encodeURIComponent(id)}`, { method: 'PUT', body: { name: v } }), 'Raktár átnevezve')
        }
        style={{ ...inputStyle, height: 40, flex: 1 }}
        aria-label="Raktár neve"
      />
      {archived ? (
        <Pill
          small
          onClick={() => run(() => api(`/api/warehouses/${encodeURIComponent(id)}`, { method: 'PUT', body: { archived: 0 } }), 'Raktár visszaállítva')}
        >
          Visszaállítás
        </Pill>
      ) : (
        <button
          type="button"
          onClick={() =>
            confirm(`Törlöd / archiválod: ${name}?`) && run(() => api(`/api/warehouses/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Raktár törölve')
          }
          style={{ border: 0, background: 'transparent', color: C.neg, font: `600 13.5px ${FONT}`, cursor: 'pointer' }}
        >
          Törlés
        </button>
      )}
    </div>
  );
}
