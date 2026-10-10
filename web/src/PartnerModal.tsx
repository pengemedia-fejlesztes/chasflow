// Partner (ügyfél / szállító) tételei egy helyen: a partner neve a fejléc, alatta a tételek (pl. Marketing tanácsadás, SEO, PPC),
// mindegyik saját összeggel, ütemezéssel és határidővel; alul új tétel. A partner általános fizetési határideje:
// rendszeres tétel → a hónap első munkanapján számlázunk + N nap; egyszeri → a felviteltől 14 nap. Bevételnél és kiadásnál ugyanígy.
import { useMemo, useState } from 'react';
import { addMonths, fmt, monthLabel, monthLong, ymOf } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { addDays, DEFAULT_PAY_DAYS, invoiceDue, ONEOFF_DAYS } from '../../shared/workdays';
import { api } from './api';
import type { EditTarget } from './EntryModal';
import { LeafPicker } from './LeafPicker';
import { REP, genSeries, rowKey, signed } from './logic';
import { useStore } from './store';
import { C, DateField, FONT, FONT_H, Modal, Pill, Seg, eyebrow, inputStyle } from './ui';

const dot = (d: string) => d.replace(/-/g, '. ') + '.';
const num = (s: string) => parseInt(String(s).replace(/\D/g, '')) || 0;

interface Item {
  key: string;
  name: string;
  rep: Rep;
  open: Entry[];
  next: Entry | null;
  tentative: boolean;
  billingo: boolean;
}

export function PartnerModal({ leaf, edit, onClose }: { leaf?: string | null; edit?: EditTarget | null; onClose: () => void }) {
  const { ix, data, commit, run } = useStore();
  // a sorozaton kívüli, azonos nevű tervek a sorozat tételéhez tartoznak (mint a táblázatban)
  const keyOf = useMemo(() => {
    const sk = new Map<string, string>();
    data.entries.forEach((e) => e.kind === 'plan' && e.series_id && sk.set(`${e.leaf_id}|${e.name}`, e.series_id));
    return (e: Entry) => e.series_id || sk.get(`${e.leaf_id}|${e.name}`) || rowKey(e);
  }, [data.entries]);
  const editEntries = edit ? data.entries.filter((e) => e.kind === 'plan' && (keyOf(e) === edit.key || rowKey(e) === edit.key)) : [];
  const initLeaf = editEntries[0]?.leaf_id || leaf || null;
  const [section, setSection] = useState<Section>(initLeaf ? ix.sectionOf(initLeaf) : 'in');
  const [partner, setPartner] = useState<string | null>(initLeaf);
  const [picking, setPicking] = useState(!initLeaf);
  const [open, setOpen] = useState<string | null>(edit?.key ?? (initLeaf ? null : 'new'));
  const L = partner ? ix.leafById[partner] : null;
  const payDays = L?.pay_days ?? DEFAULT_PAY_DAYS;
  const [term, setTerm] = useState<string | null>(null);

  // a partner tételei: nyitott (jövőbeli vagy lejárt) tervek tételenként
  const items: Item[] = useMemo(() => {
    if (!partner) return [];
    const m = new Map<string, Entry[]>();
    for (const e of data.entries) {
      if (e.kind !== 'plan' || e.leaf_id !== partner || e.done) continue;
      const k = keyOf(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return [...m.entries()]
      .map(([key, es]) => {
        es.sort((a, b) => a.date.localeCompare(b.date));
        const s = data.series.find((x) => x.id === es.find((e) => e.series_id)?.series_id);
        return {
          key,
          name: es[0].name || L?.label || '',
          rep: (s?.rep || (es.length > 1 ? 'monthly' : 'once')) as Rep,
          open: es,
          next: es.find((e) => e.date >= data.today) || es[0],
          tentative: es.some((e) => e.tentative),
          billingo: es.some((e) => e.source === 'billingo'),
        };
      })
      .sort((a, b) => (a.next?.date || '').localeCompare(b.next?.date || ''));
  }, [partner, data.entries, data.series, data.today, keyOf, L]);

  // fizetési fegyelem: Billingo számlák szerinti határidő és a tényleges beérkezés átlaga (nap)
  const avg = useMemo(() => {
    if (!partner) return null;
    const byId = new Map(data.entries.map((e) => [e.id, e]));
    const terms: number[] = [];
    const real: number[] = [];
    for (const d of data.billingo) {
      const p = d.plan_id ? byId.get(d.plan_id) : undefined;
      if (!p || p.leaf_id !== partner || !d.invoice_date) continue;
      if (d.due_date) terms.push((Date.parse(d.due_date) - Date.parse(d.invoice_date)) / 864e5);
      const a = p.done && p.link_id ? byId.get(p.link_id) : undefined;
      if (a) real.push((Date.parse(a.date) - Date.parse(d.invoice_date)) / 864e5);
    }
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
    return { term: mean(terms), real: mean(real), n: real.length };
  }, [partner, data.billingo, data.entries]);

  const saveTerm = () => {
    if (!partner || term === null) return;
    const v = term.trim() === '' ? null : Math.min(180, num(term));
    setTerm(null);
    if (v === (L?.pay_days ?? null)) return;
    run(() => api(`/api/leaves/${partner}`, { method: 'PATCH', body: { pay_days: v } }), `${L?.label}: fizetési határidő ${v ?? DEFAULT_PAY_DAYS} nap`);
  };

  return (
    <Modal onClose={onClose} width={760}>
      <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={eyebrow}>{section === 'in' ? 'Partner · bevétel' : 'Partner · kiadás'}</span>
          {L && !picking ? (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <b style={{ font: `800 26px/1.1 ${FONT_H}`, color: C.navy }}>{L.label}</b>
              <button
                onClick={() => setPicking(true)}
                style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 12.5px ${FONT}`, cursor: 'pointer', padding: 0 }}
              >
                másik partner
              </button>
            </span>
          ) : (
            <b style={{ font: `700 20px ${FONT_H}`, color: C.navy }}>Válassz partnert</b>
          )}
        </div>
        {(picking || !L) && (
          <Seg
            small
            value={section}
            onChange={(v) => {
              setSection(v);
              if (partner && ix.sectionOf(partner) !== v) setPartner(null);
            }}
            options={[
              ['in', 'Bevétel'],
              ['out', 'Kiadás'],
            ]}
          />
        )}
      </div>

      <div style={{ padding: '14px 24px 8px', display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '72vh', overflow: 'auto' }}>
        {(picking || !L) && (
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            <LeafPicker
              key={section}
              section={section}
              value={partner}
              onChange={(id) => {
                setPartner(id);
                setPicking(false);
                setOpen('new');
              }}
            />
          </div>
        )}

        {L && !picking && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '10px 12px',
                borderRadius: 12,
                background: C.bg,
                font: `500 13px ${FONT}`,
                color: C.ink,
              }}
            >
              <span style={eyebrow}>Fizetési határidő</span>
              <input
                inputMode="numeric"
                value={term ?? String(payDays)}
                onChange={(e) => setTerm(e.target.value.replace(/\D/g, '').slice(0, 3))}
                onBlur={saveTerm}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                style={{ width: 52, height: 32, border: `1px solid ${C.line2}`, borderRadius: 8, textAlign: 'center', font: `700 14px ${FONT}` }}
              />
              <span>nap a számlától</span>
              <span style={{ color: C.muted }}>
                · rendszeres: a hónap első munkanapján számlázunk + {payDays} nap · egyszeri: felviteltől {ONEOFF_DAYS} nap
              </span>
              {avg && (avg.term !== null || avg.real !== null) && (
                <span style={{ flexBasis: '100%', color: C.muted, font: `500 12.5px ${FONT}` }}>
                  Eddigi számlák: {avg.term !== null ? `átlagos határidő ${avg.term} nap` : ''}
                  {avg.real !== null ? ` · ténylegesen átlag ${avg.real} nap alatt fizetett (${avg.n} számla)` : ''}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
              {items.length === 0 && <div style={{ padding: '14px 16px', color: C.muted, font: `500 13.5px ${FONT}` }}>Még nincs nyitott tétele.</div>}
              {items.map((it, i) => (
                <ItemRow
                  key={it.key}
                  it={it}
                  first={i === 0}
                  section={section}
                  expanded={open === it.key}
                  onToggle={() => setOpen(open === it.key ? null : it.key)}
                  onSave={(b, msg) => commit(b, msg).then(() => setOpen(null))}
                />
              ))}
              <div style={{ borderTop: items.length ? `1px solid ${C.line}` : 0 }}>
                {open === 'new' ? (
                  <NewItem
                    leaf={L.id}
                    section={section}
                    payDays={payDays}
                    today={data.today}
                    cur={ix.cur}
                    onCancel={() => setOpen(null)}
                    onSave={(b, msg) => commit(b, msg).then(() => setOpen(null))}
                  />
                ) : (
                  <button
                    onClick={() => setOpen('new')}
                    style={{
                      width: '100%',
                      border: 0,
                      background: '#fff',
                      padding: '13px 16px',
                      textAlign: 'left',
                      font: `700 14px ${FONT}`,
                      color: C.blueDark,
                      cursor: 'pointer',
                    }}
                  >
                    + Új tétel ehhez a partnerhez
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <div style={{ padding: '12px 24px 16px', display: 'flex', justifyContent: 'flex-end' }}>
        <Pill onClick={onClose}>Bezárás</Pill>
      </div>
    </Modal>
  );
}

function ItemRow({
  it,
  first,
  section,
  expanded,
  onToggle,
  onSave,
}: {
  it: Item;
  first: boolean;
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  onSave: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void;
}) {
  const next = it.next;
  const [name, setName] = useState(it.name);
  const [amount, setAmount] = useState(String(Math.abs(next?.amount || 0)));
  const [date, setDate] = useState(next?.date || '');
  const [tentative, setTentative] = useState(it.tentative);
  const amt = num(amount);
  const editable = it.open.filter((e) => e.source !== 'billingo');
  const save = () => {
    if (!amt) return alert('Adj meg összeget.');
    const upsert = editable.map((e) => ({
      ...e,
      name: name.trim() || e.name,
      amount: signed(section, amt),
      tentative: tentative ? 1 : 0,
      ...(it.rep === 'once' && date ? { date } : {}),
    }));
    // a már kiszámlázott (Billingo) tétel összege a számláé – csak a név változik
    it.open.filter((e) => e.source === 'billingo').forEach((e) => upsert.push({ ...e, name: name.trim() || e.name }));
    onSave({ upsert }, `${name}: frissítve (${editable.length} nyitott tétel)`);
  };
  return (
    <div style={{ borderTop: first ? 0 : `1px solid ${C.line3}`, background: expanded ? C.bg3 : '#fff' }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          border: 0,
          background: 'transparent',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ font: `600 15px ${FONT}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', font: `500 12px ${FONT}`, color: C.muted }}>
            <span>{REP[it.rep]}</span>
            {next && <span>· következő: {dot(next.date)}</span>}
            {it.open.length > 1 && <span>· {it.open.length} nyitott</span>}
            {it.tentative && <span style={{ color: '#8A6D1C', fontWeight: 700 }}>· ajánlat</span>}
            {it.billingo && <span style={{ color: C.blueDark, fontWeight: 700 }}>· Billingo számla</span>}
          </span>
        </span>
        <b style={{ font: `700 15px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {fmt(Math.abs(next?.amount || 0))} Ft
        </b>
        <span style={{ color: C.muted, font: `700 14px ${FONT}` }}>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tétel neve" style={{ ...inputStyle, flex: '1 1 220px' }} />
            <AmountInput value={amount} onChange={setAmount} />
          </div>
          {it.rep === 'once' && date && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={eyebrow}>Várható fizetés</span>
              <DateField value={date} onChange={setDate} style={{ width: 240 }} />
            </div>
          )}
          {section === 'in' && <OfferToggle value={tentative} onChange={setTentative} />}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Pill
              kind="danger"
              small
              onClick={() =>
                confirm(`Törlöd: ${it.name} – ${editable.length} nyitott tétel?`) && onSave({ delete: editable.map((e) => e.id) }, `${it.name}: törölve`)
              }
            >
              Törlés
            </Pill>
            <Pill small onClick={onToggle}>
              Mégse
            </Pill>
            <Pill small kind="primary" onClick={save}>
              Mentés
            </Pill>
          </div>
        </div>
      )}
    </div>
  );
}

function NewItem({
  leaf,
  section,
  payDays,
  today,
  cur,
  onCancel,
  onSave,
}: {
  leaf: string;
  section: Section;
  payDays: number;
  today: string;
  cur: string;
  onCancel: () => void;
  onSave: (b: ReturnType<typeof genSeries>, msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [rep, setRep] = useState<Rep>('monthly');
  const [date, setDate] = useState(addDays(today, ONEOFF_DAYS));
  const [startYm, setStartYm] = useState(addMonths(cur, 1));
  const [count, setCount] = useState(12);
  const [tentative, setTentative] = useState(false);
  const amt = num(amount);
  const step = rep === 'quarterly' ? 3 : 1;
  const firstDue = rep === 'once' ? date : invoiceDue(startYm, payDays);
  const n = rep === 'once' ? 1 : Math.ceil(count / step);
  const save = () => {
    if (!name.trim()) return alert('Add meg a tétel nevét (pl. SEO, PPC, Marketing tanácsadás).');
    if (!amt) return alert('Adj meg összeget.');
    const b = genSeries({
      leaf,
      section,
      name: name.trim(),
      amount: amt,
      startYm: rep === 'once' ? ymOf(date) : startYm,
      count: rep === 'once' ? 1 : count,
      rep,
      day: Number(firstDue.slice(8)),
      tentative,
      payRule: rep === 'once' ? null : `inv:${payDays}`,
    });
    if (rep === 'once' && b.upsert?.[0]) b.upsert[0].date = date;
    onSave(b, `${name.trim()}: ${b.upsert!.length} tétel felvéve${tentative ? ' (ajánlat)' : ''}`);
  };
  const months = [0, 1, 2, 3].map((i) => addMonths(cur, i));
  return (
    <div
      style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, background: C.bg3 }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && save()}
    >
      <span style={{ font: `700 14px ${FONT}`, color: C.navy }}>Új tétel</span>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={section === 'in' ? 'pl. Marketing tanácsadás, SEO, PPC, riport' : 'pl. Könyvelés, tárhely, licenc'}
          style={{ ...inputStyle, flex: '1 1 240px' }}
        />
        <AmountInput value={amount} onChange={setAmount} />
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={eyebrow}>Ütemezés</span>
          <Seg
            small
            value={rep}
            onChange={setRep}
            options={[
              ['once', 'Egyszeri'],
              ['monthly', 'Havonta'],
              ['quarterly', 'Negyedévente'],
            ]}
          />
        </div>
        {rep === 'once' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={eyebrow}>Várható fizetés (felvitel + {ONEOFF_DAYS} nap)</span>
            <DateField value={date} onChange={setDate} style={{ width: 240 }} />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={eyebrow}>Első fizetés hónapja</span>
              <Seg small value={startYm} onChange={setStartYm} options={months.map((m) => [m, monthLabel(m)] as [string, string])} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={eyebrow}>Időtartam</span>
              <Seg
                small
                value={count}
                onChange={setCount}
                options={[
                  [3, '3 hó'],
                  [6, '6 hó'],
                  [12, '12 hó'],
                  [24, '24 hó'],
                ]}
              />
            </div>
          </>
        )}
      </div>
      {section === 'in' && <OfferToggle value={tentative} onChange={setTentative} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 220, font: `500 12.5px/1.45 ${FONT}`, color: C.muted }}>
          {rep === 'once'
            ? `Fizetés: ${dot(date)}`
            : `${n} tétel · első fizetés ${dot(firstDue)} (számlázás ${monthLong(startYm)} első munkanapján + ${payDays} nap)`}
          {amt ? ` · ${fmt(amt)} Ft` : ''}
        </span>
        <Pill small onClick={onCancel}>
          Mégse
        </Pill>
        <Pill small kind="primary" onClick={save}>
          Mentés ↵
        </Pill>
      </div>
    </div>
  );
}

function AmountInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const n = num(value);
  return (
    <span
      style={{
        flex: '0 0 190px',
        display: 'flex',
        alignItems: 'center',
        border: `1.5px solid ${C.blue}`,
        borderRadius: 12,
        padding: '0 12px',
        background: C.bg2,
      }}
    >
      <input
        inputMode="numeric"
        value={n ? fmt(n) : ''}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        placeholder="0"
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 0,
          background: 'transparent',
          font: `800 19px ${FONT_H}`,
          color: C.navy,
          textAlign: 'right',
          height: 42,
        }}
      />
      <span style={{ font: `600 13px ${FONT}`, color: C.blueDark, marginLeft: 6 }}>Ft</span>
    </span>
  );
}

function OfferToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13.5px ${FONT}`, color: C.ink }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.blue }} />
      Ajánlat fázisban (még nem biztos) – az Ajánlatok között is megjelenik
    </label>
  );
}
