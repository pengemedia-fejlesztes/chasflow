import { baseName } from '../../shared/monthname';
import { parseWholeForint } from '../../shared/amount';
import { VAT_RATE } from '../../shared/vat';
// Partner (ügyfél / szállító) tételei egy helyen: a partner neve a fejléc, alatta a tételek (pl. Marketing tanácsadás, SEO, PPC),
// mindegyik saját összeggel, ütemezéssel és határidővel; alul új tétel. A partner általános fizetési határideje:
// rendszeres tétel → a hónap első munkanapján számlázunk + N nap; egyszeri → a felviteltől 14 nap. Bevételnél és kiadásnál ugyanígy.
import { useEffect, useMemo, useRef, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { addMonths, fmt, monthDiff, monthLabel, monthLong, ymOf } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { addDays, invoiceDue, payDate, payRuleLabel } from '../../shared/workdays';
import type { EditTarget } from './EntryModal';
import { LeafPicker } from './LeafPicker';
import { LinkChain, diffColor, diffText, planLinks } from './LinkChain';
import { REP, acceptOffer, genSeries, planNameOf, offerLeafFor, openBillingoDoc, payDefaults, repStep, rowKey, signed, uid } from './logic';
import { CalendarSheet } from './DatePicker';
import { RejectedOffers } from './RejectedOffers';
import { useStore } from './store';
import { C, DateField, FONT, FONT_H, Modal, NetBox, Pill, Seg, card, eyebrow, inputStyle } from './ui';

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
const SM = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];
/** „2026. okt.” */
const ymShort = (ym: string) => `${ym.slice(0, 4)}. ${SM[Number(ym.slice(5, 7)) - 1]}`;
/** „nov. 17.” vagy évvel: „2026. nov. 4.” */
const dateShort = (d: string, year: boolean) => `${year ? d.slice(0, 4) + '. ' : ''}${SM[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}.`;
/** „17-én”, „1-jén”, „2-án”, „20-án” */
const dayOn = (n: number) => {
  const last = n % 10;
  const suf = n === 10 ? 'én' : n === 20 || n === 30 ? 'án' : last === 1 ? 'jén' : [2, 3, 6, 8].includes(last) ? 'án' : 'én';
  return `${n}-${suf}`;
};

/** Hónaponként egy pötty: teli = fizetve / teljesült, halvány = tervezett, szaggatott = kihagyott / üres hónap; kattintásra az a hónap nyílik. */
function MonthDots({ all, today, onPick }: { all: Entry[]; today: string; onPick: (ym: string) => void }) {
  const ms = [...new Set(all.map(periodOf))].sort();
  if (!ms.length) return null;
  const range: string[] = [];
  for (let m = ms[0]; m <= ms[ms.length - 1] && range.length < 24; m = addMonths(m, 1)) range.push(m);
  return (
    <span style={{ display: 'flex', gap: 4, flex: 'none' }} onClick={(ev) => ev.stopPropagation()}>
      {range.map((m) => {
        const es = all.filter((e) => periodOf(e) === m);
        const done = es.length > 0 && es.every((e) => e.done);
        const st = !es.length ? 'gap' : done ? 'done' : 'plan';
        const late = st === 'plan' && es.some((e) => e.date < today);
        return (
          <span
            key={m}
            role="button"
            title={`${monthLong(m)}: ${st === 'done' ? 'fizetve' : st === 'plan' ? (late ? 'lejárt, még nincs fizetve' : 'tervezett') : 'kihagyva / üres'}`}
            onClick={() => onPick(m)}
            style={{
              width: 14,
              height: 14,
              borderRadius: 4,
              cursor: 'pointer',
              background: st === 'done' ? C.blue : st === 'plan' ? (late ? '#F6C9C1' : '#D6E4EF') : 'transparent',
              border: st === 'gap' ? `1.5px dashed ${C.line2}` : 0,
            }}
          />
        );
      })}
    </span>
  );
}
/** a tétel hónapja: amelyikhez tartozik (period), különben a fizetés hónapja */
const periodOf = (e: Entry) => e.period || ymOf(e.date);
const monthRangeOf = (a: string, b: string) => {
  const out: string[] = [];
  for (let m = a; m <= b && out.length < 60; m = addMonths(m, 1)) out.push(m);
  return out;
};
const dot = (d: string) => d.replace(/-/g, '. ') + '.';
const num = (s: string) => parseWholeForint(s) || 0;

interface Item {
  key: string;
  name: string;
  rep: Rep;
  open: Entry[];
  /** a tétel összes terve (a már kifizetettek is) – a havi állapotsávhoz */
  all: Entry[];
  next: Entry | null;
  tentative: boolean;
  billingo: boolean;
  /** a következő tételhez kötött számla (Billingo / NAV) */
  inv?: string;
  /** a számla Billingo-azonosítója (kattintásra új ablakban nyílik) */
  invDoc?: number;
}

export function PartnerModal({ leaf, edit, onClose }: { leaf?: string | null; edit?: EditTarget | null; onClose: () => void }) {
  const { ix, data, commit } = useStore();
  // a sorozaton kívüli, azonos nevű tervek a sorozat tételéhez tartoznak (mint a táblázatban)
  const keyOf = useMemo(() => {
    const sk = new Map<string, string>();
    data.entries.forEach((e) => e.kind === 'plan' && e.series_id && sk.set(`${e.leaf_id}|${baseName(e.name)}`, e.series_id));
    return (e: Entry) => e.series_id || sk.get(`${e.leaf_id}|${baseName(e.name)}`) || rowKey(e);
  }, [data.entries]);
  const editEntries = edit ? data.entries.filter((e) => e.kind === 'plan' && (keyOf(e) === edit.key || rowKey(e) === edit.key)) : [];
  const initLeaf = editEntries[0]?.leaf_id || leaf || null;
  const [section, setSection] = useState<Section>(initLeaf ? ix.sectionOf(initLeaf) : 'in');
  const [partner, setPartner] = useState<string | null>(initLeaf);
  const [picking, setPicking] = useState(!initLeaf);
  // a szerkesztendő tétel kulcsa a tétel-lista kulcsa szerint (sorozat-azonosító vagy név) – így lezárt tétel is megnyílik
  const editKey = editEntries[0] ? keyOf(editEntries[0]) : (edit?.key ?? null);
  const [open, setOpen] = useState<string | null>(editKey ?? (initLeaf ? null : 'new'));
  /** a fejlécben kiválasztott hónap: a tétel hónaplistája oda ugrik, az új tétel ehhez a hónaphoz kerül */
  const [focusYm, setFocusYm] = useState<string | null>(null);
  const L = partner ? ix.leafById[partner] : null;
  const defs = payDefaults(data.settings, section);
  const payDays = L?.pay_days ?? defs.payDays;

  // a partner tételei: nyitott (jövőbeli vagy lejárt) tervek tételenként
  const items: Item[] = useMemo(() => {
    if (!partner) return [];
    const m = new Map<string, Entry[]>();
    for (const e of data.entries) {
      if (e.kind !== 'plan' || e.leaf_id !== partner) continue;
      const k = keyOf(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return [...m.entries()]
      .filter(([key, all]) => all.some((e) => !e.done) || key === editKey)
      .map(([key, all]) => {
        all.sort((a, b) => a.date.localeCompare(b.date));
        // lezárt (már kifizetett) tételnél a szerkesztő a teljes előzményt mutatja
        const es = all.some((e) => !e.done) ? all.filter((e) => !e.done) : all;
        const s = data.series.find((x) => x.id === es.find((e) => e.series_id)?.series_id);
        return {
          key,
          name: baseName(es[0].name) || L?.label || '',
          rep: (s?.rep || (new Set(all.map(periodOf)).size > 1 ? 'monthly' : 'once')) as Rep,
          open: es,
          all,
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
  }, [partner, data.entries, data.series, data.today, data.billingo, data.navInvoices, keyOf, L, editKey]);

  // a következő 12 hónap biztos tervei (ajánlat nélkül), a partner minden tételéből
  const next12 = useMemo(() => {
    if (!L) return 0;
    const to = addMonths(ix.cur, 11);
    return data.entries
      .filter((e) => e.kind === 'plan' && e.leaf_id === L.id && !e.done && !e.tentative && periodOf(e) >= ix.cur && periodOf(e) <= to)
      .reduce((a, e) => a + Math.abs(e.amount), 0);
  }, [L, data.entries, ix.cur]);

  return (
    <Modal onClose={onClose} width={860}>
      <div
        style={{
          padding: '22px 28px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          background: '#fff',
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ ...eyebrow, color: C.blue }}>
              {section === 'in' ? 'Vevő' : 'Szállító'}
              {L && !picking ? ` · ${displayGroup(ix.groupById[L.group_id]?.label || '')}` : ''}
            </span>
            {L && !picking && (
              <button
                onClick={() => setPicking(true)}
                style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 13px ${FONT}`, cursor: 'pointer', padding: 0 }}
              >
                másik partner ›
              </button>
            )}
          </span>
          {L && !picking ? (
            <b style={{ font: `800 34px/1.1 ${FONT_H}`, color: C.navy }}>{L.label}</b>
          ) : (
            <b style={{ font: `700 20px ${FONT_H}`, color: C.navy }}>Válassz partnert</b>
          )}
        </div>
        {L && !picking && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ ...eyebrow, color: C.muted }}>Következő 12 hó</span>
              <b style={{ font: `800 24px/1.1 ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(next12)} Ft</b>
            </span>
            {open !== 'new' && (
              <button
                title={`Új tétel${focusYm ? ` – ${monthName(focusYm)}` : ''}`}
                onClick={() => setOpen('new')}
                style={{
                  border: 0,
                  background: C.blue,
                  color: '#fff',
                  borderRadius: 999,
                  height: 44,
                  padding: '0 22px',
                  font: `700 15px ${FONT}`,
                  cursor: 'pointer',
                }}
              >
                + {focusYm ? monthName(focusYm) : 'Új tétel'}
              </button>
            )}
            <Pill onClick={onClose} style={{ background: '#fff' }}>
              Bezárás
            </Pill>
          </span>
        )}
        {(picking || !L) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
            <Pill onClick={onClose} style={{ background: '#fff' }}>
              Bezárás
            </Pill>
          </span>
        )}
      </div>

      <div style={{ padding: '22px 28px 24px', display: 'flex', flexDirection: 'column', gap: 14, background: C.bg }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {items.length === 0 && open !== 'new' && (
                <div style={{ padding: '14px 16px', color: C.muted, font: `500 13.5px ${FONT}` }}>Még nincs nyitott tétele.</div>
              )}
              {items.map((it, i) => (
                <ItemRow
                  key={it.key}
                  it={it}
                  first={i === 0}
                  section={section}
                  expanded={open === it.key}
                  onToggle={() => setOpen(open === it.key ? null : it.key)}
                  focusYm={open === it.key ? focusYm : null}
                  onPickMonth={(ym) => {
                    setFocusYm(ym);
                    setOpen(it.key);
                  }}
                  onSave={(b, msg) => {
                    // a szerkesztő nyitva marad (újraütemezéskor a tétel új sorozat-azonosítót kap → azt nyitjuk meg)
                    commit(b, msg);
                    const nk = (b as { series?: { id: string }[] }).series?.[0]?.id || (b.upsert?.[0] ? keyOf(b.upsert[0]) : null);
                    setOpen(nk && b.upsert?.some((e) => e.leaf_id === partner) ? nk : null);
                  }}
                  onApply={(b, msg) => commit(b, msg)}
                />
              ))}
              {open === 'new' && (
                <div style={{ ...card, borderRadius: 16, overflow: 'hidden' }}>
                  <NewItem
                    key={focusYm || 'cur'}
                    initYm={focusYm}
                    leafEntries={data.entries.filter((e) => e.leaf_id === L.id)}
                    leaf={L.id}
                    section={section}
                    payDays={payDays}
                    oneoffDays={defs.oneoffDays}
                    rule={L.pay_rule || null}
                    today={data.today}
                    cur={ix.cur}
                    onCancel={() => setOpen(null)}
                    onSave={(b, msg) =>
                      commit(b, msg).then((ok) => {
                        if (ok) setOpen(null);
                      })
                    }
                  />
                </div>
              )}
              {/* jelmagyarázat a hónap-pöttyökhöz */}
              {items.some((it) => it.rep !== 'once') && (
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '2px 6px', font: `500 13px ${FONT}`, color: C.muted }}>
                  {(
                    [
                      ['fizetve', { background: C.blue }],
                      ['tervezett', { background: '#D6E4EF' }],
                      ['lejárt', { background: '#F6C9C1' }],
                      ['kihagyva / üres', { border: `1.5px dashed ${C.line2}` }],
                    ] as [string, React.CSSProperties][]
                  ).map(([l, st]) => (
                    <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <i style={{ width: 14, height: 14, borderRadius: 4, ...st }} />
                      {l}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <ClosedItems leaf={L.id} focusKey={edit?.key && !items.some((it) => it.key === edit.key) ? edit.key : null} keyOf={keyOf} />
            <div style={{ padding: '0 4px' }}>
              <RejectedOffers leafIds={[L.id]} />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** A tétel terveinek útja (terv → számla → bank → tény, különbség): a számlázott / lezárt hónapok, a legutóbbiak elöl. */
function ItemChains({ it }: { it: Item }) {
  const { data } = useStore();
  const linked = it.all
    .filter((e) => e.done || data.billingo.some((d) => d.plan_id === e.id) || (data.navInvoices || []).some((n) => n.plan_id === e.id))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);
  if (!linked.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={eyebrow}>Terv → számla → bank → tény</span>
      {linked.map((e) => (
        <LinkChain key={e.id} plan={e} />
      ))}
    </div>
  );
}

/** A partner lezárt tételei (az elmúlt 12 hónap): terv, számla, banki tétel, tény és a különbség. */
function ClosedItems({ leaf, focusKey, keyOf }: { leaf: string; focusKey: string | null; keyOf: (e: Entry) => string }) {
  const { data, ix } = useStore();
  const [show, setShow] = useState(!!focusKey);
  const from = addMonths(ix.cur, -12) + '-01';
  const links = planLinks(data.entries, (e) => e.leaf_id === leaf && e.date >= from).sort(
    (a, b) =>
      Number(focusKey !== null && keyOf(b.plan) === focusKey) - Number(focusKey !== null && keyOf(a.plan) === focusKey) ||
      b.plan.date.localeCompare(a.plan.date),
  );
  if (!links.length) return null;
  const sum = links.reduce((a, l) => a + (l.diff || 0), 0);
  const sec = ix.sectionOf(leaf);
  return (
    <div style={{ ...card, marginTop: 6, borderRadius: 16, overflow: 'hidden' }}>
      <button
        onClick={() => setShow(!show)}
        style={{
          width: '100%',
          border: 0,
          background: '#fff',
          padding: '16px 22px',
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ color: C.navy, fontSize: 12 }}>{show ? '▾' : '▸'}</span>
        <b style={{ flex: 1, font: `700 16px ${FONT_H}`, color: C.navy }}>Lezárt tételek – terv és tény ({links.length})</b>
        <span style={{ font: `600 13.5px ${FONT}`, color: diffColor(sec, sum) }}>össz. eltérés {diffText(sum)} Ft</span>
      </button>
      {show && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 22px 18px' }}>
          {links.map((l) => (
            <div key={l.plan.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ font: `600 13px ${FONT}`, color: C.navy }}>
                {l.plan.name || ix.leafById[leaf]?.label} <span style={{ color: C.muted, fontWeight: 500 }}>· {monthName(periodOf(l.plan))}</span>
              </span>
              <LinkChain plan={l.plan} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fizetés napja: a hónap adott napja, vagy első / utolsó munkanap (a hétvégi nap az előző munkanapra kerül) */
const DAY_OPTS: [string, string][] = [
  ['first_workday', 'Első munkanap'],
  ...Array.from({ length: 31 }, (_, i) => [`day:${i + 1}`, `${i + 1}.`] as [string, string]),
  ['last_workday', 'Utolsó munkanap'],
];
const MONTH_OPTS: [number, string][] = [
  [3, '3 hó'],
  [6, '6 hó'],
  [12, '12 hó'],
  [24, '24 hó'],
  [36, '36 hó'],
];
function MonthSelect({ value, from, n, onChange }: { value: string; from: string; n: number; onChange: (ym: string) => void }) {
  const opts = Array.from({ length: n }, (_, i) => addMonths(from, i));
  if (!opts.includes(value)) opts.unshift(value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, height: 36, width: 175, padding: '0 10px' }}>
      {opts.map((m) => (
        <option key={m} value={m}>
          {monthLong(m)}
        </option>
      ))}
    </select>
  );
}
function DaySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, height: 36, width: 170, padding: '0 10px' }}>
      {DAY_OPTS.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

/**
 * Egy tétel szerkesztése – minden változás azonnal mentődik (nincs „Mentés” gomb): a név és az összeg a mező elhagyásakor,
 * a többi (ismétlődés, fizetés napja, tervezés hossza, dátum, ajánlat, áthelyezés) a választáskor.
 */
function ItemRow({
  it,
  first,
  section,
  expanded,
  onToggle,
  onSave,
  onApply,
  focusYm,
  onPickMonth,
}: {
  it: Item;
  first: boolean;
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  focusYm?: string | null;
  onPickMonth?: (ym: string) => void;
  onSave: (b: { upsert?: Entry[]; delete?: string[]; rejected?: boolean }, msg: string) => void;
  /** mentés a szerkesztő nyitva hagyásával */
  onApply: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void;
}) {
  const next = it.next;
  const { ix, data, run, canEdit } = useStore();
  const editable = it.open.filter((e) => e.source !== 'billingo');
  // a „később számlázzuk” hónapok (más hónapra tett fizetés) újraütemezéskor megmaradnak
  const shifted = editable.filter((e) => e.period && e.period !== ymOf(e.date));
  const regular = editable.filter((e) => !shifted.includes(e));
  const curLeaf = next?.leaf_id || it.open[0]?.leaf_id || '';
  // az „Ajánlatok” csoportban lévő tétel (elfogadás után a Projektekbe kerül)
  const inOffers = /aj[aá]nlat/i.test(ix.groupById[ix.leafById[curLeaf]?.group_id]?.label || '');
  const firstOpen = regular[0] || editable[0] || next;
  const series = data.series.find((x) => x.id === it.open.find((e) => e.series_id)?.series_id);
  const initDay = (() => {
    // a tervek dátumaiból: ha mind a hónap első / utolsó munkanapjára esik (és nem egy fix napra), az a választás
    const ds = regular.map((e) => e.date);
    const fixed = series?.day && ds.every((d) => d === payDate(ymOf(d), `day:${series.day}`, series.day));
    if (!fixed && ds.length) {
      if (ds.every((d) => d === payDate(ymOf(d), 'last_workday', 1))) return 'last_workday';
      if (ds.every((d) => d === payDate(ymOf(d), 'first_workday', 1))) return 'first_workday';
    }
    const r = ix.leafById[curLeaf]?.pay_rule || '';
    if (!ds.length && (r === 'first_workday' || r === 'last_workday')) return r;
    // a sorozat beállított napja (a hétvégére eső fizetés az előző munkanapra kerül, ezért nem a dátumból olvassuk)
    return `day:${series?.day || Number((firstOpen?.date || '').slice(8)) || 1}`;
  })();
  const initMonths = Math.max(1, regular.length * repStep(it.rep));
  const [name, setName] = useState(it.name);
  const [amount, setAmount] = useState(String(Math.abs(next?.amount || 0)));
  const [day, setDay] = useState(initDay);
  const [months, setMonths] = useState(initMonths);
  const [pickLeaf, setPickLeaf] = useState(false);

  /** a nyitott, nem kiszámlázott tervek újragenerálása (ismétlődés, fizetés napja, tervezés hossza változásakor) */
  const regen = (o: { rep: Rep; day: string; months: number; tentative?: boolean; startDate?: string }) => {
    // ha már minden hónap lezárt (kifizetett), az új tervek a következő hónaptól indulnak – a kifizetett hónap nem duplázódik
    const after = firstOpen && !editable.length ? `${addMonths(ymOf(firstOpen.date), 1)}-${firstOpen.date.slice(8)}` : null;
    const start = o.startDate || after || firstOpen?.date || data.today;
    const dnum = Number(o.day.replace(/\D/g, '')) || 1;
    const b = genSeries({
      leaf: curLeaf,
      section,
      name: name.trim() || it.name,
      amount: num(amount),
      startYm: ymOf(start),
      count: o.rep === 'once' ? 1 : o.months,
      rep: o.rep,
      day: dnum,
      tentative: o.tentative ?? it.tentative,
      payRule: o.rep === 'once' ? null : o.day,
    });
    if (o.rep === 'once' && b.upsert?.[0]) {
      b.upsert[0].date = start;
      b.upsert[0].series_id = null;
      b.series = [];
    }
    // a később számlázott hónap nem jön létre újra (megmarad a saját, későbbi fizetésével)
    const keep = new Set(shifted.map((e) => e.period));
    b.upsert = (b.upsert || []).filter((e) => !keep.has(ymOf(e.date)));
    // helyben módosítás: a meglévő sorozat és tételek azonosítója marad (nem kerül a kukába, nem látszik töröltként);
    // csak a rövidítéskor fölöslegessé vált hónapok törlődnek
    const sid = series?.id;
    if (sid && o.rep !== 'once') {
      b.series = (b.series || []).map((x) => ({ ...x, id: sid }));
      b.upsert.forEach((e) => (e.series_id = sid));
    }
    const old = [...regular].sort((x, y) => x.date.localeCompare(y.date));
    b.upsert.forEach((e, i) => old[i] && (e.id = old[i].id));
    b.delete = old.slice(b.upsert.length).map((e) => e.id);
    return b;
  };
  const scheduleMsg = (r: Rep, d: string, m: number) =>
    r === 'once' ? 'egyszeri' : `${REP[r].toLowerCase()}, fizetés: ${DAY_OPTS.find(([v]) => v === d)?.[1] || d}, ${m} hónapra`;

  // ── azonnali mentések ──
  const saveName = () => {
    const n = name.trim();
    if (!n || n === it.name) return;
    // a lezárt (kifizetett) hónapok is átneveződnek, így a tétel egyben marad; a szerkesztő nyitva marad az új néven
    onSave({ upsert: it.all.map((e) => ({ ...e, name: n })) }, `${it.name} → ${n}: átnevezve (${it.all.length} hónap)`);
  };
  const saveAmount = (v?: string) => {
    const a = num(v ?? amount);
    if (!a || a === Math.abs(next?.amount || 0)) return;
    // a már kiszámlázott (Billingo) tétel összege a számláé
    onApply({ upsert: editable.map((e) => ({ ...e, amount: signed(section, a) })) }, `${it.name}: ${fmt(a)} Ft (${editable.length} nyitott tétel)`);
  };
  const saveDate = (d: string) => next && onApply({ upsert: [{ ...next, date: d }] }, `${it.name}: fizetés ${dot(d)}`);
  const saveRep = (r: Mode) => {
    if (r === it.rep || !num(amount)) return;
    if (r === 'twice') {
      // két részlet: fele-fele (a 2. egy hónappal később) – utána részletenként szerkeszthető
      const base = (name.trim() || it.name).replace(/\s*[–-]\s*\d\. részlet$/, '');
      const b = partsBatch(curLeaf, section, base, halves(num(amount), firstOpen?.date || data.today), it.tentative);
      if (!b) return;
      b.delete = editable.map((e) => e.id);
      onSave(b, `${base}: 2 részletre bontva – a részletek összege és dátuma külön állítható`);
      return;
    }
    const m = r === 'yearly' ? Math.max(months, 36) : months;
    onSave(regen({ rep: r, day, months: m }), `${it.name}: ${scheduleMsg(r, day, m)}`);
  };
  const saveDay = (d: string) => {
    setDay(d);
    onSave(regen({ rep: it.rep, day: d, months }), `${it.name}: ${scheduleMsg(it.rep, d, months)}`);
  };
  // kezdő és utolsó hónap: meddig tartson a tervezés (a tervezés hossza ebből számolódik)
  const startYm = ymOf(firstOpen?.date || data.today);
  const endYm = addMonths(startYm, Math.max(0, months - repStep(it.rep)));
  const saveStart = (ym: string) => {
    if (ym === startYm) return;
    onSave(regen({ rep: it.rep, day, months, startDate: ym + '-01' }), `${it.name}: kezdés ${monthLong(ym)}, ${scheduleMsg(it.rep, day, months)}`);
  };
  const saveMonths = (m: number) => {
    setMonths(m);
    onSave(regen({ rep: it.rep, day, months: m }), `${it.name}: ${scheduleMsg(it.rep, day, m)}`);
  };
  const moveAll = (target: string, msg: string) => {
    const upsert = it.open.map((e) => ({ ...e, leaf_id: target }));
    const sids = new Set(upsert.map((e) => e.series_id).filter(Boolean));
    onSave({ upsert, series: data.series.filter((x) => sids.has(x.id)).map((x) => ({ ...x, leaf_id: target })) } as any, msg);
  };
  const saveTentative = async (t: boolean) => {
    const upsert = editable.map((e) => ({ ...e, tentative: t ? 1 : 0 }));
    // ajánlat fázisba téve: a bevételi tétel az „Ajánlatok” csoportba kerül (az elfogadás fordítottja)
    if (t && section === 'in' && !inOffers) {
      const target = await offerLeafFor(ix, curLeaf);
      if (target !== curLeaf) {
        const sids = new Set(upsert.map((e) => e.series_id).filter(Boolean));
        onSave(
          {
            upsert: upsert.map((e) => ({ ...e, leaf_id: target })),
            series: data.series.filter((x) => sids.has(x.id)).map((x) => ({ ...x, leaf_id: target })),
          } as any,
          `${it.name}: ajánlat fázisba téve → Ajánlatok`,
        );
        return;
      }
    }
    onApply({ upsert }, `${it.name}: ${t ? 'ajánlat (még nem biztos)' : 'biztos terv'}`);
  };

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 16, background: expanded ? C.bg3 : '#fff', boxShadow: '0 1px 2px rgba(0,32,64,.04)' }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          border: 0,
          background: 'transparent',
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ font: `700 16px ${FONT_H}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
            {it.tentative && (
              <span
                style={{ flex: 'none', padding: '2px 10px', borderRadius: 999, border: `1.5px dashed ${C.line2}`, font: `600 12px ${FONT}`, color: C.muted }}
              >
                ajánlat
              </span>
            )}
          </span>
          <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>
            {(() => {
              // „Havonta · 17-én · 2026. okt. – 2027. dec. · következő: nov. 17.” / „Egyszeri · 2026. nov. 4.”
              const ms = [...new Set(it.all.map(periodOf))].sort();
              if (it.rep === 'once' || !ms.length) return `${REP.once} · ${next ? dateShort(next.date, true) : ''}`;
              const day = Number((next || it.open[0] || it.all[it.all.length - 1]).date.slice(8));
              return [REP[it.rep], dayOn(day), `${ymShort(ms[0])} – ${ymShort(ms[ms.length - 1])}`, next ? `következő: ${dateShort(next.date, false)}` : '']
                .filter(Boolean)
                .join(' · ');
            })()}
            {it.inv &&
              (it.invDoc ? (
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
                  {' '}
                  · {it.inv} ↗
                </span>
              ) : (
                <span style={{ color: C.blueDark, fontWeight: 700 }}> · {it.inv}</span>
              ))}
          </span>
        </span>
        {it.rep !== 'once' && <MonthDots all={it.all} today={data.today} onPick={(m) => onPickMonth?.(m)} />}
        <b style={{ font: `700 18px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', minWidth: 110, textAlign: 'right' }}>
          {fmt(Math.abs(next?.amount || 0))} Ft
        </b>
        <span style={{ color: C.muted2, font: `700 12px ${FONT}`, transform: expanded ? 'rotate(180deg)' : undefined }}>▼</span>
      </button>
      {expanded && (
        <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* hónaponként: számla, fizetve / nincs kiszámlázva / terv */}
          {it.rep !== 'once' && <MonthStatus all={it.all} name={it.name} onPick={onPickMonth} />}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="Tétel neve"
              style={{ ...inputStyle, flex: '1 1 220px' }}
            />
            <span onBlur={() => saveAmount()} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} style={{ display: 'flex' }}>
              <AmountInput value={amount} onChange={setAmount} onNet={(g) => saveAmount(g)} />
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={eyebrow}>Ismétlődés</span>
            <Seg small value={it.rep as Mode} onChange={saveRep} options={REP_OPTS} />
          </div>
          {it.rep === 'once' && next && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={eyebrow}>Fizetés napja</span>
              <DateField value={next.date} onChange={saveDate} style={{ width: 240 }} />
            </div>
          )}
          {it.rep !== 'once' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={eyebrow}>Fizetés napja</span>
              <DaySelect value={day} onChange={saveDay} />
              <span style={eyebrow}>Tervezés</span>
              <Seg small value={months} onChange={saveMonths} options={MONTH_OPTS} />
            </div>
          )}
          {it.rep !== 'once' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={eyebrow}>Kezdés</span>
              <MonthSelect value={startYm} from={addMonths(data.today.slice(0, 7), -2)} n={26} onChange={saveStart} />
              <span style={eyebrow}>Utolsó hónap</span>
              <MonthSelect value={endYm} from={startYm} n={36} onChange={(m) => saveMonths(monthDiff(m, startYm) + 1)} />
              <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                {Math.ceil(months / repStep(it.rep))} alkalom · {monthLong(startYm)} – {monthLong(endYm)}
              </span>
            </div>
          )}
          {it.rep !== 'once' && <MonthList it={it} editable={editable} onApply={onApply} focusYm={focusYm} />}
          <ItemChains it={it} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={eyebrow}>Projekt / partner</span>
            <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>
              {ix.leafById[curLeaf]?.label} · {displayGroup(ix.groupById[ix.leafById[curLeaf]?.group_id]?.label || '')}
            </b>
            <Pill small onClick={() => setPickLeaf((x) => !x)}>
              {pickLeaf ? 'Bezár' : 'Másik projekt / partner…'}
            </Pill>
          </div>
          {pickLeaf && (
            <LeafPicker
              section={section}
              value={curLeaf}
              onChange={(id) => {
                setPickLeaf(false);
                if (id !== curLeaf)
                  moveAll(id, `${it.name}: áthelyezve → ${ix.leafById[id]?.label} (${displayGroup(ix.groupById[ix.leafById[id]?.group_id]?.label || '')})`);
              }}
            />
          )}
          <OfferToggle value={it.tentative} onChange={saveTentative} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: 1, font: `500 12px ${FONT}`, color: C.muted }}>Minden változás azonnal mentődik.</span>
            {(it.tentative || inOffers) && (
              <Pill
                small
                kind="primary"
                onClick={() =>
                  run(
                    () => acceptOffer(ix, it.open, data.series),
                    `Ajánlat elfogadva: ${it.name} – bekerült a havi tervbe${inOffers ? ' (az ügyfél a Projektek alá került)' : ''}`,
                  )
                }
              >
                {it.tentative ? '✓ Elfogadva' : '✓ Elfogadva → Projektekbe'}
              </Pill>
            )}
            {(it.tentative || inOffers) && editable.length > 0 && (
              <Pill
                small
                onClick={() =>
                  confirm(
                    `„${it.name}” ajánlat elutasítva?\n\n${editable.length} tétel kikerül a tervből, lezárt ajánlatként áthúzva látszik, és beszámít az elfogadási arányba.`,
                  ) && onSave({ delete: editable.map((e) => e.id), rejected: true }, `Ajánlat elutasítva: ${it.name} – lezárva, kikerült a tervből`)
                }
              >
                <span style={{ color: '#B3261E' }}>✕ Elutasítva</span>
              </Pill>
            )}
            <Pill
              kind="danger"
              small
              onClick={() =>
                confirm(
                  `Törlöd: ${it.name} – ${editable.length} nyitott tétel?${it.tentative ? '\n\n(Sima törlés: nem számít elutasításnak. Ha az ügyfél nemet mondott, az „Elutasítva” gombot használd.)' : ''}`,
                ) && onSave({ delete: editable.map((e) => e.id) }, `${it.name}: törölve`)
              }
            >
              Törlés
            </Pill>
            <Pill small onClick={onToggle}>
              Bezár
            </Pill>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Az új tétel ütemezései – a „Részletekben” egyszeri tétel 2–4 külön fizetéssel (saját összeg és dátum), sorozat nélkül */
const NEW_REP_OPTS: [Mode, string][] = [
  ['once', 'Egyszeri'],
  ['twice', 'Részletekben'],
  ['monthly', 'Havonta'],
  ['quarterly', '3 havonta'],
  ['yearly', 'Évente'],
];
/** részletek felosztása: előre megadott arányok (2 részletnél), egyenlő (3–4 részletnél) vagy egyedi összegek */
type Split = '50/50' | '30/70' | '40/60' | 'eq' | 'custom';
const splitOpts = (n: number): [Split, string][] =>
  n === 2
    ? [
        ['50/50', '50/50'],
        ['30/70', '30/70'],
        ['40/60', '40/60'],
        ['custom', 'egyedi'],
      ]
    : [
        ['eq', 'egyenlő'],
        ['custom', 'egyedi'],
      ];
const fractions = (split: Split, n: number): number[] =>
  split === '30/70' ? [0.3, 0.7] : split === '40/60' ? [0.4, 0.6] : split === '50/50' ? [0.5, 0.5] : Array(n).fill(1 / n);
/** a teljes díj szétosztása az arányok szerint (kerekítve; a maradék az utolsó részletbe kerül) */
const splitAmounts = (total: number, fr: number[]) => {
  const out = fr.map((f) => Math.round(total * f));
  out[out.length - 1] = total - out.slice(0, -1).reduce((a, x) => a + x, 0);
  return out;
};
/** „2026-11-14” → „11. 14.” */
const md = (d: string) => `${d.slice(5, 7)}. ${d.slice(8, 10)}.`;
const instLabel = (i: number, n: number) => (i === 0 ? 'előleg' : i === n - 1 ? 'végteljesítés' : `${i + 1}. részlet`);
const labelStrong: React.CSSProperties = { font: `700 14px ${FONT}`, color: C.navy };
const labelSoft: React.CSSProperties = { font: `500 14px ${FONT}`, color: C.muted };

function NewItem({
  initYm,
  leafEntries,
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
  initYm?: string | null;
  /** a partner tételei – a kiválasztott hónap tételei gyors kitöltéshez */
  leafEntries?: Entry[];
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
  /** a beírt összeg nettó (a mentéskor +27% ÁFA) vagy bruttó – egyszer, az egész tételre */
  const [vat, setVat] = useState<'net' | 'gross'>('gross');
  const [rep, setRep] = useState<Mode>(initYm ? 'once' : 'monthly');
  const [date, setDate] = useState(() =>
    initYm ? `${initYm}-${String(Math.min(28, Number(addDays(today, oneoffDays).slice(8)))).padStart(2, '0')}` : addDays(today, oneoffDays),
  );
  // részletek: darabszám, felosztás, egyedi összegek, dátumok (alapból 30 naponként)
  const [nParts, setNParts] = useState(2);
  const [split, setSplit] = useState<Split>('50/50');
  const [customAmts, setCustomAmts] = useState<string[]>(['', '', '', '']);
  const [dates, setDates] = useState<string[]>(() => [0, 1, 2, 3].map((i) => addDays(addDays(today, oneoffDays), 30 * i)));
  const [startYm, setStartYm] = useState(initYm || addMonths(cur, 1));
  const [count, setCount] = useState(12);
  const [tentative, setTentative] = useState(false);
  // fizetés napja: a partner szabálya (hónap napja / első-utolsó munkanap), különben a számlázás + határidő szerinti nap
  const [day, setDay] = useState(() =>
    rule && /^(day:\d+|first_workday|last_workday)$/.test(rule) ? rule : `day:${Number(invoiceDue(addMonths(cur, 1), payDays).slice(8)) || 10}`,
  );
  const amt = num(amount);
  const gross = (x: number) => (vat === 'net' ? Math.round(x * (1 + VAT_RATE)) : x);
  const step = repStep(rep === 'twice' ? 'once' : rep);
  const ruleUsed = day;
  const firstDue = rep === 'once' ? date : rep === 'twice' ? dates[0] : payDate(startYm, day, Number(day.replace(/\D/g, '')) || 1);
  const n = rep === 'once' ? 1 : rep === 'twice' ? nParts : Math.ceil(count / step);

  // a részletek összegei: a teljes díjból az arány szerint, vagy egyedi
  const partAmts = split === 'custom' ? customAmts.slice(0, nParts).map(num) : splitAmounts(amt, fractions(split, nParts));
  const partSum = partAmts.reduce((a, x) => a + x, 0);
  const partShown = (i: number) => (split === 'custom' ? customAmts[i] : amt ? fmt(partAmts[i]) : '');
  const partPct = (i: number) =>
    split === 'custom' ? (partSum ? `${Math.round((partAmts[i] / partSum) * 100)}%` : '–') : `${Math.round(fractions(split, nParts)[i] * 100)}%`;
  /** bruttó részletek; ha a részletek kiadják a teljes díjat, a bruttó összegük is pontosan a teljes díj bruttója */
  const grossParts = () => {
    const g = partAmts.map(gross);
    if (amt && partSum === amt) g[g.length - 1] = gross(amt) - g.slice(0, -1).reduce((a, x) => a + x, 0);
    return g;
  };
  const setPartAmt = (i: number, v: string) => {
    const next = Array.from({ length: 4 }, (_, j) => (j < nParts ? partShown(j) : customAmts[j]));
    next[i] = v;
    setCustomAmts(next);
    setSplit('custom');
  };
  const changeN = (k: number) => {
    if (split === 'custom') setCustomAmts(customAmts.map((v, j) => (j < k ? v : '')));
    else setSplit(k === 2 ? '50/50' : 'eq');
    setNParts(k);
  };

  const save = () => {
    if (!name.trim()) return alert('Add meg a tétel nevét (pl. SEO, PPC, Marketing tanácsadás).');
    if (rep === 'twice') {
      const g = grossParts();
      const b = partsBatch(
        leaf,
        section,
        name.trim(),
        g.map((a, i) => ({ a: a ? String(a) : '', d: dates[i] })),
        tentative,
      );
      if (b) onSave(b, `${name.trim()}: ${nParts} részlet felvéve${tentative ? ' (ajánlat)' : ''}`);
      return;
    }
    if (!amt) return alert('Adj meg összeget.');
    const b = genSeries({
      leaf,
      section,
      name: name.trim(),
      amount: gross(amt),
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
  const months = [...new Set([...(initYm ? [initYm] : []), ...[0, 1, 2, 3].map((i) => addMonths(cur, i))])].sort();
  // a kiválasztott hónap tételei (és a partner korábbi tételei): kattintásra kitölti a nevet és az összeget
  const selYm = rep === 'once' ? ymOf(date) : rep === 'twice' ? ymOf(dates[0]) : startYm;
  const sugg = useMemo(() => {
    const m = new Map<string, { name: string; amount: number; inMonth: boolean; date: string }>();
    for (const e of [...(leafEntries || [])].sort((a, b) => b.date.localeCompare(a.date))) {
      const nm = planNameOf(e.name).trim();
      if (!nm) continue;
      const inMonth = periodOf(e) === selYm;
      const k = normalizeText(nm);
      const x = m.get(k);
      if (!x || (inMonth && !x.inMonth)) m.set(k, { name: nm, amount: Math.abs(e.amount), inMonth, date: e.date });
    }
    return [...m.values()].sort((a, b) => Number(b.inMonth) - Number(a.inMonth) || b.date.localeCompare(a.date)).slice(0, 8);
  }, [leafEntries, selYm]);

  // így kerül a cashflow-ba: részletenként, egyszerinél egy pont, ismétlődőnél az első néhány fizetés
  const timeline: { amount: number; date: string; label: string }[] =
    rep === 'twice'
      ? grossParts().map((a, i) => ({ amount: a, date: dates[i], label: instLabel(i, nParts) }))
      : rep === 'once'
        ? [{ amount: gross(amt), date, label: 'egyszeri' }]
        : Array.from({ length: Math.min(n, 4) }, (_, i) => {
            const ym = addMonths(startYm, i * step);
            return { amount: gross(amt), date: payDate(ym, day, Number(day.replace(/\D/g, '')) || 1), label: monthLabel(ym) };
          });
  const more = rep === 'once' || rep === 'twice' ? 0 : n - timeline.length;
  const box: React.CSSProperties = { border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', background: '#fff' };
  const boxFoot: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
    padding: '10px 16px',
    background: C.bg3,
    borderTop: `1px solid ${C.line3}`,
    font: `500 13px ${FONT}`,
    color: C.muted,
  };
  const chipStyle = (active: boolean): React.CSSProperties => ({
    border: `1px solid ${active ? C.navy : C.line2}`,
    borderRadius: 8,
    minWidth: 36,
    height: 34,
    padding: '0 12px',
    font: `600 13.5px ${FONT}`,
    background: active ? C.navy : '#fff',
    color: active ? '#fff' : C.navy,
    cursor: 'pointer',
  });

  return (
    <div
      style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && save()}
    >
      <b style={{ font: `700 19px ${FONT_H}`, color: C.navy }}>Új tétel{initYm ? ` – ${monthName(initYm)}` : ''}</b>

      {/* Mit számlázunk? */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={labelStrong}>{section === 'in' ? 'Mit számlázunk?' : 'Mit fizetünk?'}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={section === 'in' ? 'pl. Marketing tanácsadás, SEO, PPC, riport' : 'pl. Könyvelés, tárhely, licenc'}
          style={{ ...inputStyle, height: 50, borderRadius: 12, font: `500 16px ${FONT}`, padding: '0 16px' }}
        />
        {sugg.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>Másolás korábbiból ({monthName(selYm)}):</span>
            {sugg.map((x) => (
              <button
                key={x.name}
                type="button"
                onClick={() => {
                  setName(x.name);
                  // a korábbi tételek összege bruttó
                  setAmount(String(x.amount));
                  setVat('gross');
                }}
                style={{
                  border: `1.5px solid ${x.inMonth ? C.blue : C.line2}`,
                  borderRadius: 999,
                  background: '#fff',
                  padding: '6px 14px',
                  font: `600 13px ${FONT}`,
                  color: C.blueDark,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {x.name} · {fmt(x.amount)}
                {x.inMonth ? ' ✓' : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Mennyi? / Hogyan fizet? */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span>
            <span style={labelStrong}>Mennyi?</span> <span style={labelSoft}>teljes díj</span>
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 62,
              border: `1.5px solid ${C.blue}`,
              borderRadius: 12,
              padding: '0 18px',
              background: C.bg2,
            }}
          >
            <input
              inputMode="numeric"
              value={amount}
              aria-invalid={!!amount && parseWholeForint(amount) === null}
              aria-label="Teljes díj egész forintban"
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                outline: 0,
                background: 'transparent',
                font: `800 26px ${FONT_H}`,
                color: C.navy,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
            <span style={{ font: `700 15px ${FONT}`, color: C.blueDark, marginLeft: 10 }}>Ft</span>
          </span>
          <span style={{ alignSelf: 'flex-start' }}>
            <Seg
              small
              value={vat}
              onChange={setVat}
              options={[
                ['net', 'Nettó'],
                ['gross', 'Bruttó'],
              ]}
            />
          </span>
          <span style={{ font: `500 12.5px/1.4 ${FONT}`, color: C.muted }}>
            {vat === 'net' && amt ? `+ 27% ÁFA = bruttó ${fmt(gross(amt))} Ft kerül a cashflow-ba` : 'ÁFA nélkül vagy ÁFA-val — egyszer kell megadni'}
          </span>
        </div>
        <div style={{ flex: '2 1 340px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <span style={labelStrong}>Hogyan fizet?</span>
          <span style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}>
            <Seg
              value={rep}
              onChange={(v) => {
                setRep(v);
                setCount(v === 'yearly' ? 36 : 12);
                if (v === 'twice') setDates((ds) => [date, ...ds.slice(1).map((_, i) => addDays(date, 30 * (i + 1)))]);
              }}
              options={NEW_REP_OPTS}
            />
          </span>
          {rep === 'twice' && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ ...labelSoft, minWidth: 74 }}>Részletek:</span>
                {[2, 3, 4].map((k) => (
                  <button key={k} type="button" onClick={() => changeN(k)} style={chipStyle(nParts === k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ ...labelSoft, minWidth: 74 }}>Felosztás:</span>
                {splitOpts(nParts).map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      if (v === 'custom' && split !== 'custom') setCustomAmts(Array.from({ length: 4 }, (_, j) => (j < nParts ? partShown(j) : '')));
                      setSplit(v);
                    }}
                    style={chipStyle(split === v)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Mikor? */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span>
          <span style={labelStrong}>Mikor?</span>{' '}
          <span style={labelSoft}>
            {rep === 'twice'
              ? 'a várható fizetés napja (pl. előleg, majd átadáskor a végteljesítés)'
              : rep === 'once'
                ? `a várható fizetés napja (felvitel + ${oneoffDays} nap)`
                : 'a fizetés napja és a tervezés hossza'}
          </span>
        </span>
        <div style={box}>
          {rep === 'twice' ? (
            <>
              {Array.from({ length: nParts }, (_, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    flexWrap: 'wrap',
                    padding: '10px 16px',
                    borderTop: i ? `1px solid ${C.line3}` : 0,
                  }}
                >
                  <b style={{ ...labelStrong, width: 90 }}>{i + 1}. részlet</b>
                  <span
                    style={{
                      flex: '1 1 150px',
                      maxWidth: 240,
                      display: 'flex',
                      alignItems: 'center',
                      height: 44,
                      border: `1px solid ${C.line2}`,
                      borderRadius: 10,
                      padding: '0 12px',
                      background: '#fff',
                    }}
                  >
                    <input
                      inputMode="numeric"
                      value={partShown(i)}
                      aria-label={`${i + 1}. részlet összege`}
                      aria-invalid={split === 'custom' && !!customAmts[i] && parseWholeForint(customAmts[i]) === null}
                      onChange={(e) => setPartAmt(i, e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: 0,
                        outline: 0,
                        background: 'transparent',
                        font: `700 15px ${FONT_H}`,
                        color: C.navy,
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    />
                    <span style={{ font: `600 12.5px ${FONT}`, color: C.muted, marginLeft: 8 }}>Ft</span>
                  </span>
                  <span style={{ width: 44, textAlign: 'right', font: `500 14px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {partPct(i)}
                  </span>
                  <DateField
                    value={dates[i]}
                    onChange={(v) => setDates(dates.map((d, j) => (j === i ? v : d)))}
                    style={{ flex: '1 1 220px', maxWidth: 290, height: 44 }}
                  />
                </div>
              ))}
              <div style={boxFoot}>
                <span style={{ color: split === 'custom' && amt && partSum !== amt ? C.neg : C.muted }}>
                  {!amt && !partSum
                    ? 'Írd be a teljes díjat — a részletek kitöltődnek'
                    : split === 'custom' && amt && partSum !== amt
                      ? `A részletek összege eltér a teljes díjtól (${fmt(partSum - amt)} Ft)`
                      : 'A részletek összege és dátuma külön is állítható'}
                </span>
                <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>
                  Összesen {fmt(partSum)} Ft{vat === 'net' && partSum ? ` + ÁFA` : ''}
                </b>
              </div>
            </>
          ) : rep === 'once' ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 16px' }}>
                <b style={{ ...labelStrong, width: 90 }}>Fizetés</b>
                <DateField value={date} onChange={setDate} style={{ flex: '1 1 220px', maxWidth: 290, height: 44 }} />
              </div>
              <div style={boxFoot}>
                <span>Egy összegben, a megadott napon</span>
                <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>Összesen {fmt(gross(amt))} Ft</b>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end', padding: '12px 16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={eyebrow}>Fizetés napja</span>
                  <DaySelect value={day} onChange={setDay} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={eyebrow}>Első fizetés hónapja</span>
                  <Seg small value={startYm} onChange={setStartYm} options={months.map((m) => [m, monthLabel(m)] as [string, string])} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={eyebrow}>Tervezés (hány hónapig)</span>
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
                        : MONTH_OPTS
                    }
                  />
                </div>
              </div>
              <div style={boxFoot}>
                <span>
                  {n} tétel · első fizetés {dot(firstDue)} ({payRuleLabel(day)}, {count} hónapig)
                </span>
                <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>Összesen {fmt(gross(amt) * n)} Ft</b>
              </div>
            </>
          )}
        </div>
      </div>

      <OfferToggle value={tentative} onChange={setTentative} />

      {/* Így kerül a cashflow-ba */}
      <div style={{ background: C.bg, borderRadius: 12, padding: '14px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={eyebrow}>Így kerül a cashflow-ba</span>
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))` }}>
            {timeline.map((p, i) => (
              <div key={i} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, paddingRight: 8 }}>
                {i < timeline.length - 1 && <i style={{ position: 'absolute', top: 6, left: 7, right: 0, height: 2, background: '#BFD6E6' }} />}
                <i style={{ position: 'relative', width: 13, height: 13, borderRadius: 999, background: C.blue, marginBottom: 6 }} />
                <b style={{ font: `700 14px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amount)} Ft</b>
                <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {md(p.date)} · {p.label}
                </span>
              </div>
            ))}
          </div>
          {more > 0 && <span style={{ font: `600 12.5px ${FONT}`, color: C.muted, paddingTop: 20, whiteSpace: 'nowrap' }}>+ még {more}</span>}
        </div>
        {tentative && <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>Ajánlatként: az Ajánlatok között, nem biztos tervként.</span>}
      </div>

      {/* lábléc */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180, font: `500 13px ${FONT}`, color: C.muted }}>Enter = mentés · Esc = bezárás</span>
        <Pill onClick={onCancel}>Mégse</Pill>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={save}
          style={{
            border: 0,
            borderRadius: 999,
            height: 48,
            padding: '0 26px',
            font: `700 15px ${FONT}`,
            background: name.trim() ? C.blue : '#A9BED0',
            color: '#fff',
            cursor: name.trim() ? 'pointer' : 'default',
          }}
        >
          {name.trim() ? 'Mentés ↵' : 'Adj nevet a tételnek'}
        </button>
      </div>
    </div>
  );
}

// ───────── Részletekben fizetett egyszeri tétel ─────────
/** egy részlet: összeg (bruttó, szövegként) és a várható fizetés napja */
interface Part {
  a: string;
  d: string;
}
/** alapértelmezés: fele-fele, a 2. részlet egy hónappal később */
function halves(total: number, date: string): Part[] {
  const h = Math.round(total / 2);
  return [
    { a: total ? String(h) : '', d: date },
    { a: total ? String(total - h) : '', d: addDays(date, 30) },
  ];
}
/** a részletek egyszeri tervként, „<név> – 1. részlet”, „<név> – 2. részlet” … néven */
function partsBatch(leaf: string, section: Section, base: string, parts: Part[], tentative: boolean) {
  if (parts.some((p) => !num(p.a))) return void alert('Add meg minden részlet összegét.');
  if (parts.some((p) => !p.d)) return void alert('Add meg minden részlet dátumát.');
  const mk = (i: number, p: Part): Entry => ({
    id: uid('e'),
    kind: 'plan',
    date: p.d,
    leaf_id: leaf,
    name: `${base} – ${i}. részlet`,
    amount: signed(section, num(p.a)),
    series_id: null,
    done: 0,
    tentative: tentative ? 1 : 0,
    source: 'manual',
    ext_ref: null,
    link_id: null,
    note: null,
  });
  return { upsert: parts.map((p, i) => mk(i + 1, p)), series: [] as any[], delete: [] as string[] };
}

// ───────── Rendszeres tétel hónaponként: melyik hónaphoz tartozik, kiszámlázva-e, később számlázzuk / kihagyjuk ─────────
/**
 * Havi állapotsáv: melyik hónap díja hol tart – kifizetve, kiszámlázva (nyitott / lejárt), még nincs kiszámlázva, vagy
 * csak terv. Az elmúlt 3 és a következő 3 hónap (a tétel „melyik hónaphoz tartozik” szerint).
 */
function MonthStatus({ all, name, onPick }: { all: Entry[]; name: string; onPick?: (ym: string) => void }) {
  const { data } = useStore();
  const cur = data.today.slice(0, 7);
  const from = addMonths(cur, -3),
    to = addMonths(cur, 3);
  const leaf = all[0]?.leaf_id;
  const plans = all.filter((e) => periodOf(e) >= from && periodOf(e) <= to);
  // a terv nélküli, de ugyanilyen nevű tények (pl. régi, importált „Havi díj” befizetések) is a hónapjukhoz kerülnek
  const linked = new Set(data.entries.filter((e) => e.kind === 'plan' && e.link_id).map((e) => e.link_id));
  const planMonths = new Set(plans.map(periodOf));
  const nn = normalizeText(planNameOf(name));
  const acts = data.entries.filter(
    (e) =>
      e.kind === 'actual' &&
      e.leaf_id === leaf &&
      !linked.has(e.id) &&
      normalizeText(planNameOf(e.name)) === nn &&
      ymOf(e.date) >= from &&
      ymOf(e.date) <= cur &&
      !planMonths.has(ymOf(e.date)),
  );
  const rows = [...plans, ...acts].sort((a, b) => periodOf(a).localeCompare(periodOf(b)));
  if (!rows.length) return null;
  // kimaradt hónap (se terv, se befizetés) az első felvett hónaptól a mai hónapig
  const got = new Set(rows.map(periodOf));
  const gaps = periodOf(rows[0]) < cur ? monthRangeOf(periodOf(rows[0]), cur).filter((m) => !got.has(m)) : [];
  const list: { ym: string; e?: Entry }[] = [...rows.map((e) => ({ ym: periodOf(e), e })), ...gaps.map((ym) => ({ ym }))].sort((a, b) =>
    a.ym.localeCompare(b.ym),
  );
  // a terv nélküli tényhez tartozó Billingo-számla: azonos összeg, a fizetés ±10 napon belül
  const docOfActual = (e: Entry) =>
    data.billingo.find((d) => !d.plan_id && d.gross === e.amount && d.paid_date && Math.abs(Date.parse(d.paid_date) - Date.parse(e.date)) <= 10 * 86400_000);
  const short = (n?: string | null) => (n ? n.replace(/^.*\/\s*/, '') : '');
  // a hónapra kattintva a tétel kinyílik, és a hónaplista oda ugrik (a fejlécben is ez a hónap lesz kiválasztva)
  const pick = (ym: string) => ({
    role: 'button' as const,
    tabIndex: 0,
    onClick: (ev: React.MouseEvent) => {
      if (!onPick) return;
      ev.stopPropagation();
      onPick(ym);
    },
    onKeyDown: (ev: React.KeyboardEvent) => {
      if (onPick && ev.key === 'Enter') {
        ev.stopPropagation();
        onPick(ym);
      }
    },
  });
  return (
    <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 3 }}>
      {list.map(({ ym, e }) => {
        if (!e)
          return (
            <span
              key={'gap' + ym}
              {...pick(ym)}
              title={`${monthName(ym)}: nincs felvéve se terv, se befizetés – kattints, és felveheted`}
              style={{
                cursor: onPick ? 'pointer' : undefined,
                borderRadius: 999,
                padding: '2px 8px',
                background: C.negBg,
                color: C.neg,
                font: `600 11px ${FONT}`,
                whiteSpace: 'nowrap',
              }}
            >
              {monthLabel(ym)} · nincs felvéve
            </span>
          );
        const isAct = e.kind === 'actual';
        const doc = isAct ? docOfActual(e) : data.billingo.find((d) => d.plan_id === e.id);
        const nav = isAct ? undefined : (data.navInvoices || []).find((d) => d.plan_id === e.id);
        const paid = isAct || !!e.done || doc?.payment_status === 'paid' || nav?.status === 'paid';
        const late = e.date < data.today;
        const [txt, fg, bg] = paid
          ? ['fizetve ✓', '#2E7D4F', '#E8F4EC']
          : doc || nav
            ? [late ? 'kiszámlázva, nincs fizetve' : 'kiszámlázva', late ? C.neg : C.blueDark, late ? C.negBg : C.bg2]
            : late
              ? ['nincs kiszámlázva', C.neg, C.negBg]
              : ['terv', '#8A6D1C', '#FFF9E6'];
        return (
          <span
            key={e.id}
            {...pick(periodOf(e))}
            title={`${monthName(periodOf(e))} · fizetés ${dot(e.date)} · ${fmt(Math.abs(e.amount))} Ft${doc ? ` · számla ${doc.number || ''}` : nav ? ` · NAV-számla ${nav.invoice_number}` : ''}`}
            style={{
              cursor: onPick ? 'pointer' : undefined,
              borderRadius: 999,
              padding: '2px 8px',
              background: bg,
              color: fg,
              font: `600 11px ${FONT}`,
              whiteSpace: 'nowrap',
            }}
          >
            {monthLabel(periodOf(e))}
            {doc?.number || nav?.invoice_number ? ` · ${short(doc?.number || nav?.invoice_number)}` : ''} · {txt}
          </span>
        );
      })}
    </span>
  );
}

/** a hónaplista sorai egységes oszlopokkal: hónap · fizetés · összeg · állapot · műveletek */
const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(170px,1.1fr) minmax(150px,.9fr) minmax(190px,1fr) minmax(130px,.9fr) auto',
  alignItems: 'center',
  gap: '6px 14px',
  padding: '9px 14px',
};
const ACTS: React.CSSProperties = { display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap', whiteSpace: 'nowrap' };

function MonthList({
  it,
  editable,
  onApply,
  focusYm,
}: {
  it: Item;
  editable: Entry[];
  onApply: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void;
  focusYm?: string | null;
}) {
  const { data, ix } = useStore();
  const [moving, setMoving] = useState<string | null>(null);
  const [dating, setDating] = useState<Entry | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusYm) return;
    const el = boxRef.current?.querySelector(`[data-ym="${focusYm}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusYm]);
  const base = planNameOf(it.name);
  /** havidíjas tételnél a sor neve a hónappal: „Havi díj – 2026. szeptember” */
  const title = (ym: string) => (
    <b style={{ color: C.navy }}>
      {base} – {monthName(ym)}
    </b>
  );
  const hl = (ym: string) => (focusYm === ym ? { boxShadow: `inset 4px 0 0 ${C.blue}` } : {});
  const [adding, setAdding] = useState(false);
  const docOf = (e: Entry) => data.billingo.find((d) => d.plan_id === e.id);
  const navOf = (e: Entry) => (data.navInvoices || []).find((d) => d.plan_id === e.id);
  // a lezárt (kifizetett) hónapok is látszanak az elmúlt 12 hónapból – így látszik, melyik hónap van már rendezve
  const from = addMonths(ix.cur, -12);
  const closed = it.all.filter((e) => e.done && periodOf(e) >= from);
  // terv nélküli, de ugyanilyen nevű tények (pl. régi, importált „Havi díj” befizetések) a hónapjukhoz
  const leaf = it.all[0]?.leaf_id;
  const linked = new Set(data.entries.filter((e) => e.kind === 'plan' && e.link_id).map((e) => e.link_id));
  const planMonths = new Set(it.all.map(periodOf));
  const nn = normalizeText(planNameOf(it.name));
  const acts = data.entries.filter(
    (e) =>
      e.kind === 'actual' &&
      e.leaf_id === leaf &&
      !linked.has(e.id) &&
      normalizeText(planNameOf(e.name)) === nn &&
      ymOf(e.date) >= from &&
      !planMonths.has(ymOf(e.date)),
  );
  const recs = [...it.open, ...closed, ...acts].sort((a, b) => periodOf(a).localeCompare(periodOf(b)) || a.date.localeCompare(b.date));
  // minden hónap látszik az első felvett hónaptól a mai hónapig: ahol nincs semmi, ott „nincs felvéve” sor
  const recMonths = new Set(recs.map(periodOf));
  const firstYm = recs.length ? periodOf(recs[0]) : ix.cur;
  const gaps = firstYm < ix.cur ? monthRangeOf(firstYm, ix.cur).filter((m) => !recMonths.has(m)) : [];
  const rows: (Entry | { gap: string })[] = [...recs, ...gaps.map((gap) => ({ gap }))].sort((a, b) =>
    ('gap' in a ? a.gap : periodOf(a)).localeCompare('gap' in b ? b.gap : periodOf(b)),
  );
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  // elmaradt hónap: az elmúlt 12 hónapból (és a következő 3-ból) azok, amelyekhez még nincs terv ennél a tételnél
  const have = new Set([...it.all.map(periodOf), ...acts.map(periodOf)]);
  const missing = Array.from({ length: 16 }, (_, i) => addMonths(from, i)).filter((m) => !have.has(m));
  const tpl = it.next || it.open[it.open.length - 1] || it.all[it.all.length - 1];
  const addMonth = (ym: string) => {
    if (!tpl) return;
    const day = Math.min(28, Number(tpl.date.slice(8)) || 10);
    const date = `${ym}-${String(day).padStart(2, '0')}`;
    setAdding(false);
    onApply(
      {
        upsert: [
          {
            ...tpl,
            id: uid('e'),
            date,
            period: null,
            done: 0,
            link_id: null,
            source: 'manual',
            ext_ref: null,
            plan_amount: null,
            bill_amount: null,
            note: null,
            amount: signed(ix.sectionOf(tpl.leaf_id), Math.abs(tpl.amount)),
          } as Entry,
        ],
      },
      `${it.name} – ${monthName(ym)}: elmaradt hónap felvéve (${fmt(Math.abs(tpl.amount))} Ft, fizetés ${dot(date)})`,
    );
  };
  const later = (e: Entry, ym: string) => {
    const day = Math.min(28, Number(e.date.slice(8)) || 1);
    const nd = `${ym}-${String(day).padStart(2, '0')}`;
    setMoving(null);
    onApply({ upsert: [{ ...e, date: nd, period: periodOf(e) }] }, `${it.name} – ${monthName(periodOf(e))}: később számlázzuk, fizetés ${dot(nd)}`);
  };
  return (
    <div ref={boxRef} style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, border: `1px solid ${C.line3}`, overflow: 'hidden' }}>
      {dating && (
        <CalendarSheet
          value={dating.date}
          onClose={() => setDating(null)}
          onPick={(d) => {
            const e = dating;
            setDating(null);
            if (d !== e.date) onApply({ upsert: [{ ...e, date: d, period: periodOf(e) }] }, `${base} – ${monthName(periodOf(e))}: fizetési határidő ${dot(d)}`);
          }}
        />
      )}
      <div style={{ padding: '8px 12px', background: C.bg, ...eyebrow }}>
        Hónapok ({it.open.length} nyitott{closed.length + acts.length ? ` · ${closed.length + acts.length} rendezve` : ''}
        {gaps.length ? ` · ${gaps.length} nincs felvéve` : ''})
      </div>
      {rows.map((e) => {
        if ('gap' in e)
          return (
            <div
              key={'gap' + e.gap}
              data-ym={e.gap}
              style={{
                ...ROW,
                borderTop: `1px solid ${C.line3}`,
                font: `500 13px ${FONT}`,
                background: '#FFF7F6',
                ...hl(e.gap),
              }}
            >
              {title(e.gap)}
              <span style={{ gridColumn: '2 / span 3', color: '#B3261E', fontWeight: 600 }}>nincs felvéve (se terv, se befizetés)</span>
              <span style={ACTS}>
                {tpl && editable.length + closed.length > 0 && (
                  <Pill small onClick={() => addMonth(e.gap)}>
                    + Felvétel ({fmt(Math.abs(tpl.amount))} Ft)
                  </Pill>
                )}
              </span>
            </div>
          );
        if (e.done || e.kind === 'actual') {
          const act = e.kind === 'actual' ? e : e.link_id ? byId.get(e.link_id) : undefined;
          const doc = e.kind === 'actual' ? undefined : docOf(e);
          return (
            <div
              key={e.id}
              data-ym={periodOf(e)}
              style={{
                ...ROW,
                borderTop: `1px solid ${C.line3}`,
                font: `500 13px ${FONT}`,
                background: '#F6FBF8',
                ...hl(periodOf(e)),
              }}
            >
              {title(periodOf(e))}
              <span style={{ color: C.muted }}>{act ? `befizetve ${dot(act.date)}` : `fizetés ${dot(e.date)}`}</span>
              {/* terv · tény · eltérés (bevételnél a több, kiadásnál a kevesebb a jó) */}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {e.kind === 'plan' && act ? (
                  (() => {
                    const pl = Math.abs(e.plan_amount ?? e.amount),
                      ac = Math.abs(act.amount),
                      d = ac - pl;
                    const good = ix.sectionOf(e.leaf_id) === 'in' ? d > 0 : d < 0;
                    return (
                      <>
                        terv {fmt(pl)} · tény <b>{fmt(ac)}</b>
                        {d !== 0 && (
                          <b style={{ marginLeft: 6, color: good ? '#1A7340' : C.neg }}>
                            {d > 0 ? '▲' : '▼'} {fmt(Math.abs(d))}
                          </b>
                        )}
                      </>
                    );
                  })()
                ) : (
                  <>{fmt(Math.abs(act?.amount ?? e.amount))} Ft</>
                )}
              </span>
              <span style={{ color: '#2E7D4F', fontWeight: 700 }}>
                ✓ {e.kind === 'actual' ? 'befizetve (terv nélkül)' : act ? 'fizetve' : 'kész'}
                {doc && (
                  <a href="#" onClick={(ev) => (ev.preventDefault(), openBillingoDoc(doc.id))} style={{ color: C.blueDark, marginLeft: 8 }}>
                    számla {doc.number || ''} ↗
                  </a>
                )}
              </span>
              <span />
            </div>
          );
        }
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
            data-ym={p}
            style={{
              ...ROW,
              borderTop: `1px solid ${C.line3}`,
              font: `500 13px ${FONT}`,
              ...hl(p),
            }}
          >
            {title(p)}
            <span style={{ color: C.muted }}>
              {canEdit && !doc ? (
                <button
                  type="button"
                  title="Fizetési határidő módosítása"
                  onClick={() => setDating(e)}
                  style={{
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    font: 'inherit',
                    color: C.blueDark,
                    cursor: 'pointer',
                    textDecoration: 'underline dotted',
                  }}
                >
                  📅 fizetés {dot(e.date)} ✎
                </button>
              ) : (
                <>fizetés {dot(e.date)}</>
              )}
              {shifted ? ' · később számlázva' : ''}
            </span>
            {canEdit && !doc ? (
              <MonthAmount
                e={e}
                onSave={(v) => onApply({ upsert: [{ ...e, amount: signed(ix.sectionOf(e.leaf_id), v) }] }, `${it.name} – ${monthName(p)}: ${fmt(v)} Ft`)}
              />
            ) : (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(Math.abs(e.amount))} Ft</span>
            )}
            <span>
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
            {canEdit && !doc ? (
              <span style={moving === e.id ? { ...ACTS, gridColumn: '1 / -1', justifyContent: 'flex-start', flexWrap: 'wrap' } : ACTS}>
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
            ) : (
              <span />
            )}
          </div>
        );
      })}
      {editable.length + closed.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', borderTop: `1px solid ${C.line3}` }}>
          {adding ? (
            <>
              <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>Melyik hónap maradt ki?</span>
              {missing.map((ym) => (
                <Pill key={ym} small onClick={() => addMonth(ym)}>
                  {monthLabel(ym)} {ym.slice(0, 4)}
                </Pill>
              ))}
              {!missing.length && <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>Nincs kimaradt hónap az elmúlt egy évben.</span>}
              <Pill small onClick={() => setAdding(false)}>
                Mégse
              </Pill>
            </>
          ) : (
            <Pill small onClick={() => setAdding(true)}>
              + Elmaradt hónap felvétele
            </Pill>
          )}
        </div>
      )}
    </div>
  );
}

/** Egy hónap összege a listában: átírható, Enter / kikattintás = mentés. */
function MonthAmount({ e, onSave }: { e: Entry; onSave: (v: number) => void }) {
  const [v, setV] = useState(fmt(Math.abs(e.amount)));
  useEffect(() => setV(fmt(Math.abs(e.amount))), [e.amount]);
  const save = () => {
    const n = num(v);
    if (n > 0 && n !== Math.abs(e.amount)) onSave(n);
    else setV(fmt(Math.abs(e.amount)));
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 90 }} title="Az adott hónap összege – írd át, Enter = mentés">
      <input
        value={v}
        inputMode="numeric"
        onChange={(ev) => setV(ev.target.value)}
        onFocus={(ev) => ev.target.select()}
        onBlur={save}
        onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
        style={{ ...inputStyle, width: 110, height: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums', padding: '0 8px' }}
      />
      Ft
      <NetBox value={v} onChange={(g) => (setV(fmt(Number(g))), onSave(Number(g)))} small />
    </label>
  );
}

function AmountInput({ value, onChange, onNet }: { value: string; onChange: (v: string) => void; onNet?: (gross: string) => void }) {
  return (
    <span
      style={{
        flex: '0 0 190px',
        position: 'relative',
        marginBottom: 18,
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
        value={value}
        aria-invalid={!!value && parseWholeForint(value) === null}
        aria-label="Összeg egész forintban"
        onChange={(e) => onChange(e.target.value)}
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
      <span style={{ position: 'absolute', right: 4, bottom: -20 }}>
        <NetBox value={value} onChange={(g) => (onChange(g), onNet?.(g))} small />
      </span>
    </span>
  );
}

function OfferToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13.5px ${FONT}`, color: C.ink }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.blue }} />
      Ajánlat fázisban (még nem biztos) — az Ajánlatok között is megjelenik
    </label>
  );
}
