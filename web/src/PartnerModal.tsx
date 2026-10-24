// Partner (ügyfél / szállító) tételei egy helyen: a partner neve a fejléc, alatta a tételek (pl. Marketing tanácsadás, SEO, PPC),
// mindegyik saját összeggel, ütemezéssel és határidővel; alul új tétel. A partner általános fizetési határideje:
// rendszeres tétel → a hónap első munkanapján számlázunk + N nap; egyszeri → a felviteltől 14 nap. Bevételnél és kiadásnál ugyanígy.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, fmt, monthLabel, monthLong, ymOf } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { addDays, invoiceDue, payDate, payRuleLabel } from '../../shared/workdays';
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
  const { ix, data, commit } = useStore();
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

  return (
    <Modal onClose={onClose} width={760}>
      <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={eyebrow}>{section === 'in' ? 'Vevő · bevétel' : 'Szállító · kiadás'}</span>
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
}: {
  it: Item;
  first: boolean;
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  onSave: (b: { upsert?: Entry[]; delete?: string[] }, msg: string) => void;
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
    const r = ix.leafById[curLeaf]?.pay_rule || '';
    if (r === 'first_workday' || r === 'last_workday') return r;
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
    const start = o.startDate || firstOpen?.date || data.today;
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
    b.delete = regular.map((e) => e.id);
    return b;
  };
  const scheduleMsg = (r: Rep, d: string, m: number) =>
    r === 'once' ? 'egyszeri' : `${REP[r].toLowerCase()}, fizetés: ${DAY_OPTS.find(([v]) => v === d)?.[1] || d}, ${m} hónapra`;

  // ── azonnali mentések ──
  const saveName = () => {
    const n = name.trim();
    if (!n || n === it.name) return;
    onApply({ upsert: it.open.map((e) => ({ ...e, name: n })) }, `${it.name} → ${n}: átnevezve`);
  };
  const saveAmount = () => {
    const a = num(amount);
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
      const b = twoPartBatch(curLeaf, section, base, halves(num(amount), firstOpen?.date || data.today), it.tentative);
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
        <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="Tétel neve"
              style={{ ...inputStyle, flex: '1 1 220px' }}
            />
            <span onBlur={saveAmount} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} style={{ display: 'flex' }}>
              <AmountInput value={amount} onChange={setAmount} />
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
          {it.rep !== 'once' && <MonthList it={it} editable={editable} onApply={onApply} />}
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
              Bezár
            </Pill>
          </div>
        </fieldset>
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
  // fizetés napja: a partner szabálya (hónap napja / első-utolsó munkanap), különben a számlázás + határidő szerinti nap
  const [day, setDay] = useState(() =>
    rule && /^(day:\d+|first_workday|last_workday)$/.test(rule) ? rule : `day:${Number(invoiceDue(addMonths(cur, 1), payDays).slice(8)) || 10}`,
  );
  const amt = num(amount);
  const step = repStep(rep === 'twice' ? 'once' : rep);
  const ruleUsed = day;
  const firstDue = rep === 'once' || rep === 'twice' ? date : payDate(startYm, day, Number(day.replace(/\D/g, '')) || 1);
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
              : `${n} tétel · első fizetés ${dot(firstDue)} (${payRuleLabel(day)}, ${count} hónapig)`}
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
