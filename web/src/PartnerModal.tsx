// Partner (ügyfél / szállító) tételei egy helyen: a partner neve a fejléc, alatta a tételek (pl. Marketing tanácsadás, SEO, PPC),
// mindegyik saját összeggel, ütemezéssel és határidővel; alul új tétel. A partner általános fizetési határideje:
// rendszeres tétel → a hónap első munkanapján számlázunk + N nap; egyszeri → a felviteltől 14 nap. Bevételnél és kiadásnál ugyanígy.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, fmt, monthLabel, monthLong, ymOf } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { addDays, invoiceDue, payDate, payRuleLabel } from '../../shared/workdays';
import { api } from './api';
import type { EditTarget } from './EntryModal';
import { LeafPicker } from './LeafPicker';
import { REP, acceptOffer, genSeries, offerLeafFor, openBillingoDoc, payDefaults, repStep, rowKey, signed, uid } from './logic';
import { useStore } from './store';
import { C, DateField, FONT, FONT_H, Modal, Pill, Seg, eyebrow, inputStyle } from './ui';

/** Ütemezés: a „két részletben” egyszeri tétel két külön fizetéssel (saját összeg és dátum), sorozat nélkül */
type Mode = Rep | 'twice';
const REP_OPTS: [Mode, string][] = [
  ['once', 'Egyszeri'],
  ['twice', 'Egyszeri, 2 részletben'],
  ['monthly', 'Havonta'],
  ['quarterly', '3 havonta'],
  ['yearly', 'Évente'],
];
/** „2026-10” → „2026. október” */
const monthName = (ym: string) => monthLong(ym);
/** a tétel hónapja: amelyikhez tartozik (period), különben a fizetés hónapja */
const periodOf = (e: Entry) => e.period || ymOf(e.date);
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
  /** a következő tételhez kötött számla (Billingo / NAV) */
  inv?: string;
  /** a számla Billingo-azonosítója (kattintásra új ablakban nyílik) */
  invDoc?: number;
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
  const defs = payDefaults(data.settings);
  const payDays = L?.pay_days ?? defs.payDays;
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
          ...(() => {
            const ids = new Set(es.map((e) => e.id));
            const b = data.billingo.find((d) => d.plan_id && ids.has(d.plan_id));
            if (b) return { inv: `számla ${b.number || ''} · ${b.payment_status === 'paid' ? 'fizetve' : 'kiszámlázva, nyitott'}`, invDoc: b.id };
            const n = (data.navInvoices || []).find((d) => d.plan_id && ids.has(d.plan_id));
            return { inv: n ? `NAV-számla ${n.invoice_number}${n.status === 'paid' ? ' · fizetve' : ''}` : undefined };
          })(),
        };
      })
      .sort((a, b) => (a.next?.date || '').localeCompare(b.next?.date || ''));
  }, [partner, data.entries, data.series, data.today, data.billingo, data.navInvoices, keyOf, L]);

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
    run(
      () =>
        api(`/api/leaves/${partner}`, {
          method: 'PATCH',
          body: { pay_days: v, ...(!L?.pay_rule || /^inv:/.test(L.pay_rule) ? { pay_rule: v === null ? null : `inv:${v}` } : {}) },
        }),
      `${L?.label}: fizetési határidő ${v ?? defs.payDays} nap`,
    );
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

      <div style={{ padding: '14px 24px 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
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
                · rendszeres: a hónap első munkanapján számlázunk + {payDays} nap · egyszeri: felviteltől {defs.oneoffDays} nap
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
                  onApply={(b, msg) => commit(b, msg)}
                />
              ))}
              <div style={{ borderTop: items.length ? `1px solid ${C.line}` : 0 }}>
                {open === 'new' ? (
                  <NewItem
                    leaf={L.id}
                    section={section}
                    payDays={payDays}
                    oneoffDays={defs.oneoffDays}
                    rule={L.pay_rule || null}
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
  onApply,
}: {
  it: Item;
  first: boolean;
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  onSave: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void;
  /** mentés a szerkesztő nyitva hagyásával (egy hónap áthelyezése / kihagyása) */
  onApply: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void;
}) {
  const next = it.next;
  const [name, setName] = useState(it.name);
  const [amount, setAmount] = useState(String(Math.abs(next?.amount || 0)));
  const [date, setDate] = useState(next?.date || '');
  const [tentative, setTentative] = useState(it.tentative);
  const [rep, setRep] = useState<Mode>(it.rep);
  const [parts, setParts] = useState<Parts>(() => halves(Math.abs(next?.amount || 0), next?.date || new Date().toISOString().slice(0, 10)));
  const { ix, data, run } = useStore();
  // az „Ajánlatok” csoportban lévő tétel (elfogadás után a Projektekbe kerül)
  const inOffers = /aj[aá]nlat/i.test(ix.groupById[ix.leafById[it.open[0]?.leaf_id]?.group_id]?.label || '');
  const curLeaf = next?.leaf_id || it.open[0]?.leaf_id || '';
  const [leafTo, setLeafTo] = useState(curLeaf);
  const [pickLeaf, setPickLeaf] = useState(false);
  const moved = !!leafTo && leafTo !== curLeaf;
  const amt = num(amount);
  const editable = it.open.filter((e) => e.source !== 'billingo');
  /** másik partnerhez / projekthez áthelyezés: a nyitott tételek és a sorozatuk is átkerül */
  const moveTo = <T extends { upsert?: Entry[]; series?: any[] }>(b: T, target: string): T => {
    if (!target || target === curLeaf) return b;
    b.upsert = (b.upsert || []).map((e) => ({ ...e, leaf_id: target }));
    const sids = new Set((b.upsert || []).map((e) => e.series_id).filter(Boolean));
    const ser = data.series.filter((x) => sids.has(x.id) && !(b.series || []).some((y: any) => y.id === x.id)).map((x) => ({ ...x, leaf_id: target }));
    b.series = [...(b.series || []).map((x: any) => ({ ...x, leaf_id: target })), ...ser];
    return b;
  };
  const whereMsg = (target: string) =>
    target && target !== curLeaf
      ? ` → ${ix.leafById[target]?.label || 'Ajánlatok'} (${displayGroup(ix.groupById[ix.leafById[target]?.group_id]?.label || 'Ajánlatok')})`
      : '';
  const save = async () => {
    if (rep !== 'twice' && !amt) return alert('Adj meg összeget.');
    // ajánlat fázisba téve: a bevételi tétel az „Ajánlatok” csoportba kerül (ha nem választottál kézzel másik helyet)
    const toOffer = section === 'in' && tentative && !inOffers && !moved;
    const target = moved ? leafTo : toOffer ? await offerLeafFor(ix, curLeaf) : curLeaf;
    const movedMsg = whereMsg(target);
    if (rep === 'twice') {
      const base = (name.trim() || it.name).replace(/\s*[–-]\s*\d\. részlet$/, '');
      const b = twoPartBatch(next?.leaf_id || curLeaf, section, base, parts, tentative);
      if (!b) return;
      b.delete = editable.map((e) => e.id);
      onSave(moveTo(b, target), `${base}: 2 részlet (${fmt(num(parts.a1))} + ${fmt(num(parts.a2))} Ft)${movedMsg}`);
      return;
    }
    if (rep !== it.rep && next) {
      // ismétlődés váltás: a nyitott (nem kiszámlázott) tervek újragenerálódnak a következő dátumtól
      const start = (rep === 'once' ? date : next.date) || next.date;
      const b = genSeries({
        leaf: next.leaf_id,
        section,
        name: name.trim() || it.name,
        amount: amt,
        startYm: ymOf(start),
        count: rep === 'once' ? 1 : rep === 'yearly' ? 36 : 12,
        rep,
        day: Number(start.slice(8)) || 1,
        tentative,
      });
      if (rep === 'once' && b.upsert?.[0]) {
        b.upsert[0].date = start;
        b.series = [];
        b.upsert[0].series_id = null;
      }
      b.delete = editable.map((e) => e.id);
      onSave(moveTo(b, target), `${name || it.name}: ${REP[rep].toLowerCase()} · ${b.upsert!.length} tétel${movedMsg}`);
      return;
    }
    const upsert = editable.map((e) => ({
      ...e,
      name: name.trim() || e.name,
      amount: signed(section, amt),
      tentative: tentative ? 1 : 0,
      ...(it.rep === 'once' && date ? { date } : {}),
    }));
    // a már kiszámlázott (Billingo) tétel összege a számláé – csak a név változik
    it.open.filter((e) => e.source === 'billingo').forEach((e) => upsert.push({ ...e, name: name.trim() || e.name }));
    onSave(
      moveTo({ upsert }, target),
      target !== curLeaf
        ? `${name || it.name}: ${toOffer ? 'ajánlat fázisba téve' : 'áthelyezve'}${movedMsg}`
        : `${name}: frissítve (${editable.length} nyitott tétel)`,
    );
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
            {next && (
              <span>
                · következő: {dot(next.date)}
                {it.rep !== 'once' ? ` (${monthName(periodOf(next))})` : ''}
              </span>
            )}
            {it.open.length > 1 && <span>· {it.open.length} nyitott</span>}
            {it.tentative && <span style={{ color: '#8A6D1C', fontWeight: 700 }}>· ajánlat</span>}
            {it.inv ? (
              it.invDoc ? (
                <span
                  role="link"
                  tabIndex={0}
                  title="A számla megnyitása új ablakban"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openBillingoDoc(it.invDoc!);
                  }}
                  onKeyDown={(ev) => ev.key === 'Enter' && (ev.stopPropagation(), openBillingoDoc(it.invDoc!))}
                  style={{ color: C.blueDark, fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}
                >
                  · {it.inv} ↗
                </span>
              ) : (
                <span style={{ color: C.blueDark, fontWeight: 700 }}>· {it.inv}</span>
              )
            ) : (
              <span style={{ color: '#8A6D1C' }}>· terv (még nincs számla)</span>
            )}
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
            {rep !== 'twice' && <AmountInput value={amount} onChange={setAmount} />}
          </div>
          {it.rep === 'once' && rep === 'once' && date && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={eyebrow}>Várható fizetés</span>
              <DateField value={date} onChange={setDate} style={{ width: 240 }} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={eyebrow}>Ismétlődés</span>
            <Seg small value={rep} onChange={setRep} options={REP_OPTS} />
            {rep !== it.rep && rep !== 'twice' && (
              <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                {rep === 'once' ? 'csak a következő tétel marad' : `${rep === 'yearly' ? '3 évre' : '12 hónapra'} újratervezve ${dot(next?.date || '')}-tól`}
              </span>
            )}
          </div>
          {rep === 'twice' && <TwoPartsEditor value={parts} onChange={setParts} />}
          {it.rep !== 'once' && rep === it.rep && <MonthList it={it} editable={editable} onApply={onApply} />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={eyebrow}>Projekt / partner</span>
            <b style={{ font: `700 13.5px ${FONT}`, color: moved ? C.blueDark : C.navy }}>
              {ix.leafById[leafTo]?.label} · {displayGroup(ix.groupById[ix.leafById[leafTo]?.group_id]?.label || '')}
            </b>
            <Pill small onClick={() => setPickLeaf((x) => !x)}>
              {pickLeaf ? 'Bezár' : 'Másik projekt / partner…'}
            </Pill>
            {moved && <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>mentéskor átkerül ide ({it.open.length} nyitott tétel)</span>}
          </div>
          {pickLeaf && (
            <LeafPicker
              section={section}
              value={leafTo}
              onChange={(id) => {
                setLeafTo(id);
                setPickLeaf(false);
              }}
            />
          )}
          <OfferToggle value={tentative} onChange={setTentative} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {(it.tentative || inOffers) && (
              <Pill
                small
                kind="primary"
                onClick={() =>
                  run(
                    () => acceptOffer(ix, it.open, data.series),
                    `Ajánlat elfogadva: ${it.name} – bekerült a havi tervbe${/aj[aá]nlat/i.test(ix.groupById[ix.leafById[it.open[0]?.leaf_id]?.group_id]?.label || '') ? ' (az ügyfél a Projektek alá került)' : ''}`,
                  )
                }
              >
                {it.tentative ? '✓ Elfogadva' : '✓ Elfogadva → Projektekbe'}
              </Pill>
            )}
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
  oneoffDays,
  rule,
  today,
  cur,
  onCancel,
  onSave,
}: {
  leaf: string;
  section: Section;
  payDays: number;
  oneoffDays: number;
  rule?: string | null;
  today: string;
  cur: string;
  onCancel: () => void;
  onSave: (b: ReturnType<typeof genSeries>, msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [rep, setRep] = useState<Mode>('monthly');
  const [date, setDate] = useState(addDays(today, oneoffDays));
  const [parts, setParts] = useState<Parts>(() => halves(0, addDays(today, oneoffDays)));
  const [startYm, setStartYm] = useState(addMonths(cur, 1));
  const [count, setCount] = useState(12);
  const [tentative, setTentative] = useState(false);
  const amt = num(amount);
  const step = repStep(rep === 'twice' ? 'once' : rep);
  // a partner fizetési feltétele (Fizetési feltételek fül), különben számla a hónap első munkanapján + határidő
  const ruleUsed = rule || `inv:${payDays}`;
  const firstDue = rep === 'once' || rep === 'twice' ? date : rule ? payDate(startYm, rule, 1) : invoiceDue(startYm, payDays);
  const n = rep === 'once' ? 1 : rep === 'twice' ? 2 : Math.ceil(count / step);
  const save = () => {
    if (!name.trim()) return alert('Add meg a tétel nevét (pl. SEO, PPC, Marketing tanácsadás).');
    if (rep === 'twice') {
      const b = twoPartBatch(leaf, section, name.trim(), parts, tentative);
      if (b) onSave(b, `${name.trim()}: 2 részlet felvéve${tentative ? ' (ajánlat)' : ''}`);
      return;
    }
    if (!amt) return alert('Adj meg összeget.');
    const b = genSeries({
      leaf,
      section,
      name: name.trim(),
      amount: amt,
      startYm: rep === 'once' ? ymOf(date) : startYm,
      count: rep === 'once' ? 1 : count,
      rep: rep as Rep,
      day: Number(firstDue.slice(8)),
      tentative,
      payRule: rep === 'once' ? null : ruleUsed,
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
        {rep !== 'twice' && <AmountInput value={amount} onChange={setAmount} />}
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={eyebrow}>Ütemezés</span>
          <Seg
            small
            value={rep}
            onChange={(v) => {
              setRep(v);
              setCount(v === 'yearly' ? 36 : 12);
              if (v === 'twice' && amt && !num(parts.a1) && !num(parts.a2)) setParts(halves(amt, date));
            }}
            options={REP_OPTS}
          />
        </div>
        {rep === 'twice' ? (
          <TwoPartsEditor value={parts} onChange={setParts} />
        ) : rep === 'once' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={eyebrow}>Várható fizetés (felvitel + {oneoffDays} nap)</span>
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
                options={
                  rep === 'yearly'
                    ? [
                        [12, '1 év'],
                        [24, '2 év'],
                        [36, '3 év'],
                      ]
                    : [
                        [3, '3 hó'],
                        [6, '6 hó'],
                        [12, '12 hó'],
                        [24, '24 hó'],
                      ]
                }
              />
            </div>
          </>
        )}
      </div>
      <OfferToggle value={tentative} onChange={setTentative} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 220, font: `500 12.5px/1.45 ${FONT}`, color: C.muted }}>
          {rep === 'twice'
            ? `1. részlet ${dot(parts.d1)} · 2. részlet ${dot(parts.d2)} · összesen ${fmt(num(parts.a1) + num(parts.a2))} Ft`
            : rep === 'once'
              ? `Fizetés: ${dot(date)}`
              : `${n} tétel · első fizetés ${dot(firstDue)} (${rule ? payRuleLabel(rule) : `számlázás ${monthLong(startYm)} első munkanapján + ${payDays} nap`})`}
          {amt && rep !== 'twice' ? ` · ${fmt(amt)} Ft` : ''}
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

// ───────── Két részletben fizetett egyszeri tétel ─────────
interface Parts {
  a1: string;
  d1: string;
  a2: string;
  d2: string;
}
/** alapértelmezés: fele-fele, a 2. részlet egy hónappal később */
function halves(total: number, date: string): Parts {
  const h = Math.round(total / 2);
  return { a1: total ? String(h) : '', d1: date, a2: total ? String(total - h) : '', d2: addDays(date, 30) };
}
function twoPartBatch(leaf: string, section: Section, base: string, p: Parts, tentative: boolean) {
  if (!num(p.a1) || !num(p.a2)) return void alert('Add meg mindkét részlet összegét.');
  if (!p.d1 || !p.d2) return void alert('Add meg mindkét részlet dátumát.');
  const mk = (i: 1 | 2, a: string, d: string): Entry => ({
    id: uid('e'),
    kind: 'plan',
    date: d,
    leaf_id: leaf,
    name: `${base} – ${i}. részlet`,
    amount: signed(section, num(a)),
    series_id: null,
    done: 0,
    tentative: tentative ? 1 : 0,
    source: 'manual',
    ext_ref: null,
    link_id: null,
    note: null,
  });
  return { upsert: [mk(1, p.a1, p.d1), mk(2, p.a2, p.d2)], series: [] as any[], delete: [] as string[] };
}
function TwoPartsEditor({ value, onChange }: { value: Parts; onChange: (p: Parts) => void }) {
  const row = (i: 1 | 2) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ ...eyebrow, minWidth: 92 }}>{i}. részlet</span>
      <AmountInput value={i === 1 ? value.a1 : value.a2} onChange={(v) => onChange({ ...value, [i === 1 ? 'a1' : 'a2']: v })} />
      <DateField value={i === 1 ? value.d1 : value.d2} onChange={(v) => onChange({ ...value, [i === 1 ? 'd1' : 'd2']: v })} style={{ width: 220 }} />
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 12, background: C.bg }}>
      {row(1)}
      {row(2)}
      <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
        Összesen {fmt(num(value.a1) + num(value.a2))} Ft · a dátum a várható fizetés napja (pl. előleg, majd átadáskor a végteljesítés)
      </span>
    </div>
  );
}

// ───────── Rendszeres tétel hónaponként: melyik hónaphoz tartozik, kiszámlázva-e, később számlázzuk / kihagyjuk ─────────
function MonthList({ it, editable, onApply }: { it: Item; editable: Entry[]; onApply: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void }) {
  const { data } = useStore();
  const [moving, setMoving] = useState<string | null>(null);
  const docOf = (e: Entry) => data.billingo.find((d) => d.plan_id === e.id);
  const navOf = (e: Entry) => (data.navInvoices || []).find((d) => d.plan_id === e.id);
  const rows = [...it.open].sort((a, b) => periodOf(a).localeCompare(periodOf(b)) || a.date.localeCompare(b.date));
  const later = (e: Entry, ym: string) => {
    const day = Math.min(28, Number(e.date.slice(8)) || 1);
    const nd = `${ym}-${String(day).padStart(2, '0')}`;
    setMoving(null);
    onApply({ upsert: [{ ...e, date: nd, period: periodOf(e) }] }, `${it.name} – ${monthName(periodOf(e))}: később számlázzuk, fizetés ${dot(nd)}`);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, border: `1px solid ${C.line3}`, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: C.bg, ...eyebrow }}>Hónapok ({rows.length} nyitott)</div>
      {rows.map((e) => {
        const doc = docOf(e);
        const nav = navOf(e);
        const p = periodOf(e);
        const late = !doc && !nav && e.date < data.today;
        const shifted = e.period && e.period !== ymOf(e.date);
        const canEdit = editable.some((x) => x.id === e.id);
        const opts = [0, 1, 2, 3, 4, 5].map((i) => addMonths(ymOf(e.date > data.today ? e.date : data.today), i + (e.date > data.today ? 1 : 0)));
        return (
          <div
            key={e.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '8px 12px',
              borderTop: `1px solid ${C.line3}`,
              font: `500 13px ${FONT}`,
            }}
          >
            <b style={{ minWidth: 130, color: C.navy }}>{monthName(p)}</b>
            <span style={{ color: C.muted, minWidth: 150 }}>
              fizetés {dot(e.date)}
              {shifted ? ' · később számlázva' : ''}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 90 }}>{fmt(Math.abs(e.amount))} Ft</span>
            <span style={{ flex: 1, minWidth: 140 }}>
              {doc ? (
                <a href="#" onClick={(ev) => (ev.preventDefault(), openBillingoDoc(doc.id))} style={{ color: C.blueDark, fontWeight: 700 }}>
                  számla {doc.number || ''} {doc.payment_status === 'paid' ? '· fizetve' : '· nyitott'} ↗
                </a>
              ) : nav ? (
                <span style={{ color: C.blueDark, fontWeight: 600 }}>NAV-számla {nav.invoice_number}</span>
              ) : (
                <span style={{ color: late ? '#B3261E' : '#8A6D1C', fontWeight: late ? 700 : 500 }}>{late ? 'még nincs kiszámlázva' : 'terv'}</span>
              )}
            </span>
            {canEdit && !doc && (
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {moving === e.id ? (
                  <>
                    <span style={{ color: C.muted }}>Számlázás hónapja:</span>
                    {opts.map((ym) => (
                      <Pill key={ym} small onClick={() => later(e, ym)}>
                        {monthLabel(ym)}
                      </Pill>
                    ))}
                    <Pill small onClick={() => setMoving(null)}>
                      Mégse
                    </Pill>
                  </>
                ) : (
                  <>
                    <Pill small onClick={() => setMoving(e.id)}>
                      Később számlázzuk…
                    </Pill>
                    <Pill
                      small
                      kind="danger"
                      onClick={() =>
                        confirm(`${it.name} – ${monthName(p)}: ezt a hónapot nem számlázzuk (a terv törlődik)?`) &&
                        onApply({ delete: [e.id] }, `${it.name} – ${monthName(p)}: kihagyva`)
                      }
                    >
                      Kihagyjuk
                    </Pill>
                  </>
                )}
              </span>
            )}
          </div>
        );
      })}
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
