import { baseName, hasMonth } from '../../shared/monthname';
import { parseWholeForint } from '../../shared/amount';
// Kategória (csoport) nézet: tervezett sorozatok havi rácsban + a szűrt időszak tényei.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, endOfMonth, fmt, monthLabel, monthLong, monthRange, ymOf } from '../../shared/model';
import type { DeletedEntry, Entry, Rep } from '../../shared/types';
import { api } from './api';
import type { EditTarget } from './EntryModal';
import { itemLabel } from './MonthList';
import {
  REP,
  planActual,
  planNameOf,
  repStep,
  ruleOf,
  dateIn,
  deleteEntries,
  extendRows,
  genSeries,
  markDone,
  rowKey,
  shiftEntries,
  signed,
  uid,
} from './logic';
import { PlanDiff, usePlanOfActual } from './LinkChain';
import { PartnerLink } from './PartnerCard';
import { CalendarSheet } from './DatePicker';
import { budgetMonth } from '../../shared/budget';
import { RejectedOffers } from './RejectedOffers';
import { useStore } from './store';
import { C, FONT, FONT_H, LeafSelect, NetBox, Seg, ShowDeletedToggle, card, eyebrow, inputStyle, useShowDeleted } from './ui';

const GOOD = '#1A7340';
const GOOD_BG = '#E8F5EE';

export function CategoryView({ groupId, openModal }: { groupId: string; openModal: (leaf: string | null, edit?: EditTarget) => void }) {
  const { ix, data, filters, setFilters, commit, canEdit, run, openPartner, showToast } = useStore();
  const [openP, setOpenP] = useState<Record<string, boolean>>({});
  const G = ix.groupById[groupId];
  const leafIds = useMemo(() => new Set(ix.leaves.filter((l) => l.group_id === groupId).map((l) => l.id)), [ix, groupId]);
  const section = G?.section || 'out';
  const sign = section === 'in' ? 1 : -1;
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const firstLeaf = ix.leaves.find((l) => l.group_id === groupId && !l.archived)?.id || '';
  const [qa, setQa] = useState({ name: '', amount: '', leaf: firstLeaf, m: ix.cur, rep: 'monthly' as Rep, count: 6, newLeaf: '' });
  const [showAll, setShowAll] = useState(false);
  const planOfActual = usePlanOfActual();
  // „Tények a szűrt időszakban” lista: becsukható, az állapot megmarad
  const [factsOpen, setFactsOpenS] = useState(() => {
    try {
      return localStorage.getItem('cf_facts_open') !== '0';
    } catch {
      return true;
    }
  });
  const setFactsOpen = (v: boolean) => {
    setFactsOpenS(v);
    try {
      localStorage.setItem('cf_facts_open', v ? '1' : '0');
    } catch {}
  };
  // a kijelölt tétel(ek) fizetésének pontos napja naptárból
  const [selCal, setSelCal] = useState(false);
  // a tervhez kötött tény a terv hónapjába számít (pl. a novemberi könyvelési díjat október 30-án fizettük → november)
  const planOfAct = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of data.entries) if (e.kind === 'plan' && e.link_id) m.set(e.link_id, e);
    return m;
  }, [data.entries]);
  const [showDeleted] = useShowDeleted();
  if (!G) return null;
  const NEW = '__new';
  const qaLeaf = qa.leaf === NEW || !firstLeaf ? NEW : leafIds.has(qa.leaf) ? qa.leaf : firstLeaf;
  // az Ajánlatok mappában felvett tétel ajánlat (még nem biztos)
  const offerGroup = /aj[áa]nlat/i.test(G.label);
  const newWord = section === 'in' ? 'ügyfél' : 'partner';

  // a kategória utolsó tervezett hónapjáig látszik (pl. 2027. decemberig tervezett tétel), legfeljebb 24 hónap –
  // a múltbeli hónapok is látszanak (terv vs. tény), lapozni a fejléc nyilaival lehet
  // az Ajánlatok oldalon minden nyitott ajánlat látszik, akkor is, ha egy másik mappában (pl. Projektek) lévő partner tétele
  const inView = (e: Entry) => leafIds.has(e.leaf_id) || (offerGroup && e.kind === 'plan' && !!e.tentative && !e.done && ix.sectionOf(e.leaf_id) === section);
  const lastPlanYm = data.entries.reduce((a, e) => (e.kind === 'plan' && !e.done && inView(e) && ymOf(e.date) > a ? ymOf(e.date) : a), filters.to);
  const allMonths = monthRange(filters.from, lastPlanYm);
  const months = allMonths.slice(0, 24);
  const visibleSet = new Set(months);
  const groupEntries = data.entries.filter(inView);
  const planEntries = groupEntries.filter((e) => e.kind === 'plan');
  // a sorozaton kívüli (pl. importált, számlához kötött) terv az azonos nevű sorozat sorába kerül (pl. „Havi díj”)
  const seriesKey = new Map<string, string>();
  for (const e of planEntries) if (e.series_id) seriesKey.set(`${e.leaf_id}|${e.name}`, e.series_id);
  const keyOf = (e: Entry) => e.series_id || seriesKey.get(`${e.leaf_id}|${e.name}`) || rowKey(e);
  const rowsMap = new Map<string, Entry[]>();
  for (const e of planEntries) {
    const k = keyOf(e);
    if (!rowsMap.has(k)) rowsMap.set(k, []);
    rowsMap.get(k)!.push(e);
  }
  // törölt tervek (kuka): áthúzva látszanak a havi rácsban, egy kattintással visszaállíthatók
  const delMap = new Map<string, DeletedEntry[]>();
  // csak ha fent be van jelölve a „Töröltek mutatása”
  for (const d of showDeleted ? data.deleted || [] : []) {
    if (!leafIds.has(d.leaf_id) || !visibleSet.has(ymOf(d.date))) continue;
    const k = rowKey(d);
    // újraütemezett tétel régi változata: ha ugyanazzal a névvel él egy sor ennél a partnernél, a régi nem kell áthúzva
    if (!rowsMap.has(k) && planEntries.some((e) => e.leaf_id === d.leaf_id && baseName(e.name) === baseName(d.name))) continue;
    if (!delMap.has(k)) delMap.set(k, []);
    delMap.get(k)!.push(d);
    if (!rowsMap.has(k)) rowsMap.set(k, []);
  }
  const restore = (ds: DeletedEntry[]) =>
    run(() => api('/api/trash/restore', { body: { rids: ds.map((d) => d.rid) } }), `${ds[0].name || 'Tétel'} visszaállítva`);
  const actualById = new Map(data.entries.filter((e) => e.kind === 'actual').map((e) => [e.id, e]));
  // a csak törölt tervekből álló sornak nincs élő tétele – a kukás tétel adja a nevét
  const headOf = ([k, es]: [string, Entry[]]): Entry | undefined => es[0] || (delMap.get(k) || [])[0];
  const rows = [...rowsMap.entries()]
    .filter(([k, es]) => es.some((e) => visibleSet.has(ymOf(e.date))) || delMap.has(k))
    .filter(([, es]) => !filters.search || es.some((e) => (e.name + ' ' + ix.leafById[e.leaf_id]?.label).toLowerCase().includes(filters.search.toLowerCase())))
    .sort(
      (a, b) =>
        (ix.leafById[headOf(a)?.leaf_id || '']?.label || '').localeCompare(ix.leafById[headOf(b)?.leaf_id || '']?.label || '', 'hu') ||
        (headOf(a)?.name || '').localeCompare(headOf(b)?.name || '', 'hu'),
    );

  const rangeEnd = endOfMonth(filters.to) < data.today ? endOfMonth(filters.to) : data.today;
  const actuals = groupEntries
    .filter((e) => e.kind === 'actual' && e.date >= filters.from + '-01' && e.date <= rangeEnd)
    .filter((e) => !filters.search || (e.name + ' ' + ix.leafById[e.leaf_id]?.label).toLowerCase().includes(filters.search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date));
  const actSum = actuals.reduce((s, e) => s + e.amount * sign, 0);
  const planSum = planEntries.filter((e) => visibleSet.has(ymOf(e.date)) && !e.tentative).reduce((s, e) => s + e.amount * sign, 0);
  const openSum = planEntries.filter((e) => visibleSet.has(ymOf(e.date)) && !e.done && !e.tentative).reduce((s, e) => s + e.amount * sign, 0);

  const selIds = Object.keys(sel).filter((k) => sel[k]);
  const selSum = data.entries.filter((e) => sel[e.id]).reduce((s, e) => s + e.amount * sign, 0);
  const clear = () => setSel({});

  const qaSave = async () => {
    const amt = parseWholeForint(qa.amount) || 0;
    if (!amt) return showToast({ msg: 'Pozitív egész forintösszeget adj meg, tizedesjel nélkül.', error: true });
    let leaf = qaLeaf;
    let payRule: string | null = null;
    if (leaf === NEW) {
      // új ügyfél/partner ebben a mappában, majd rögtön a tétel hozzá
      const label = qa.newLeaf.trim();
      if (!label) return showToast({ msg: `Add meg az új ${newWord} nevét.`, error: true });
      const same = ix.leaves.find((l) => l.group_id === groupId && !l.archived && l.label.toLowerCase() === label.toLowerCase());
      if (same) leaf = same.id;
      else
        try {
          leaf = (await api<{ id: string }>('/api/leaves', { body: { group_id: groupId, label } })).id;
          payRule = G.pay_rule || null;
          await run(async () => {});
        } catch (e: any) {
          return showToast({ msg: e.message, error: true });
        }
    } else payRule = ruleOf(ix, leaf);
    const name = qa.name.trim() || ix.leafById[leaf]?.label || qa.newLeaf.trim();
    const b = genSeries({ leaf, section, name, amount: amt, startYm: qa.m, count: qa.count, rep: qa.rep, day: 10, payRule, tentative: offerGroup });
    if (!(await commit(b, `${b.upsert!.length} tétel felvéve: ${name}`))) return;
    setQa({ ...qa, name: '', amount: '', leaf, newLeaf: '' });
  };

  // --- partnerenkénti összesítés ---
  const nz = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const actualsIn = groupEntries.filter((e) => e.kind === 'actual' && visibleSet.has(ymOf(e.date)) && ymOf(e.date) <= ix.cur);
  const linkedActual = new Set(planEntries.filter((e) => e.link_id).map((e) => e.link_id as string));
  const sumBy = (es: Entry[], m: string) => es.filter((e) => ymOf(e.date) === m).reduce((a, e) => a + e.amount * sign, 0);
  const plansOf = (leaf: string) => planEntries.filter((e) => e.leaf_id === leaf && !e.tentative);
  // keret-terv (pl. „Előre nem látható költség” 50 000/hó): a kategóriába sorolt tételek ebből fogynak, nem adódnak hozzá
  const budgetOf = (leaf: string, m: string) =>
    section === 'out'
      ? budgetMonth(
          groupEntries.filter((e) => e.leaf_id === leaf),
          ix.leafById[leaf]?.label || '',
          m,
        )
      : null;
  const leafPlan = (leaf: string, m: string) => budgetOf(leaf, m)?.plan ?? sumBy(plansOf(leaf), m);
  // ajánlatok (még nem biztos tervek) külön – a „Terv” sorban nincsenek benne, az „Ajánlat” sorban látszanak
  const offersAll = planEntries.filter((e) => e.tentative && !e.done);
  const leafOffer = (leaf: string, m: string) =>
    sumBy(
      offersAll.filter((e) => e.leaf_id === leaf),
      m,
    );
  const monthOffer = (m: string) => sumBy(offersAll, m);
  const actMonth = (e: Entry) => {
    const p = planOfAct.get(e.id);
    return p ? p.period || ymOf(p.date) : ymOf(e.date);
  };
  const leafAct = (leaf: string, m: string) =>
    groupEntries
      .filter((e) => e.kind === 'actual' && e.leaf_id === leaf && actMonth(e) === m && ymOf(e.date) <= ix.cur)
      .reduce((a, e) => a + e.amount * sign, 0);
  const monthPlan = (m: string) => [...new Set(planEntries.map((e) => e.leaf_id))].reduce((a, l) => a + leafPlan(l, m), 0);
  // terv ↔ tény: a tervhez az a tény tartozik, amihez számlamozgás (kötés) van – a terv hónapjában
  const pa = planActual(data.entries, (l) => leafIds.has(l), sign);
  /**
   * Tervhez nem kötött tények tételenként (név szerint), és az összevont banki tételek (pl. bankköltség) részletei
   * a mögöttük lévő banki tranzakciókból – így a partner/kategória alatt látszik, miből jött össze az összeg.
   */
  type ActRow = {
    key: string;
    name: string;
    byMonth: Record<string, number>;
    count: number;
    recurring: number;
    avg: number;
    planned: boolean;
    merged?: boolean;
  };
  const actualRows = (leaf: string): ActRow[] => {
    const m = new Map<string, ActRow>();
    const add = (name: string, ym: string, amt: number, merged = false) => {
      const k = nz(name) || '—';
      if (!m.has(k)) m.set(k, { key: `${leaf}|${k}`, name: name || '—', byMonth: {}, count: 0, recurring: 0, avg: 0, planned: false, merged });
      const r = m.get(k)!;
      r.byMonth[ym] = (r.byMonth[ym] || 0) + amt;
      r.count++;
    };
    for (const e of actualsIn) {
      if (e.leaf_id !== leaf) continue;
      if (e.id.startsWith('m_')) {
        const txs = data.bankTx.filter((t) => t.actual_id === e.id);
        if (txs.length) txs.forEach((t) => add((t.memo || t.partner || 'Banki tétel').split(' · ')[0].slice(0, 60), ymOf(t.date), t.amount * sign, true));
        else add(e.name, ymOf(e.date), e.amount * sign, true);
      } else if (!linkedActual.has(e.id)) add(e.name, ymOf(e.date), e.amount * sign);
    }
    // rendszeres, de nincs beütemezve: az elmúlt 4 lezárt hónapból legalább 3-ban volt, és nincs rá jövőbeli terv
    const past = [1, 2, 3, 4].map((i) => addMonths(ix.cur, -i));
    for (const r of m.values()) {
      const hist = groupEntries.filter((e) => e.kind === 'actual' && e.leaf_id === leaf && nz(e.name) === nz(r.name) && past.includes(ymOf(e.date)));
      const ms = new Set(hist.map((e) => ymOf(e.date)));
      r.recurring = ms.size;
      r.avg = ms.size ? Math.round(hist.reduce((a, e) => a + Math.abs(e.amount), 0) / ms.size) : 0;
      // az összevont banki tételeket (pl. bankköltség) a kategória havi terve fedi le
      if (r.merged) r.planned = true;
      else r.planned = planEntries.some((e) => e.leaf_id === leaf && nz(e.name) === nz(r.name) && e.date >= data.today);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'hu'));
  };
  const partners = [
    ...new Set([
      ...rows.map(([k, es]) => ((es[0] || (delMap.get(k) || [])[0]) as Entry | undefined)?.leaf_id).filter(Boolean),
      ...actualsIn.map((e) => e.leaf_id),
    ] as string[]),
  ]
    .filter(
      (l) =>
        !filters.search || (ix.leafById[l]?.label || '').toLowerCase().includes(filters.search.toLowerCase()) || rows.some(([, es]) => es[0]?.leaf_id === l),
    )
    .sort((a, b) => (ix.leafById[a]?.label || '').localeCompare(ix.leafById[b]?.label || '', 'hu'));

  // javaslat: az elmúlt 3 lezárt hónap tényleges átlaga vs. ugyanezen hónapok terve – ha a költség tartósan több
  // (bevételnél kevesebb), mint amennyit terveztünk, látszódjon, mennyi lenne a reális havi keret
  // a lezárt (elmúlt 3) hónap: a folyó hónap még nem teljes, ezért nem számít bele
  const sugMonths = [3, 2, 1].map((i) => addMonths(ix.cur, -i));
  const suggest = (() => {
    const out: { leaf: string; avg: number; plan: number; suggested: number; diff: number }[] = [];
    if (section !== 'out') return out;
    for (const leaf of leafIds) {
      const per = sugMonths.map((m) =>
        groupEntries.filter((e) => e.kind === 'actual' && e.leaf_id === leaf && ymOf(e.date) === m).reduce((a, e) => a + e.amount * sign, 0),
      );
      const used = per.filter((v) => v !== 0);
      if (!used.length) continue;
      const avg = Math.round(used.reduce((a, v) => a + v, 0) / used.length);
      // ugyanezen hónapok terve (átlag) – a tény ehhez mérve; ha akkor nem volt terv, a jövő havi terv
      const planPer = sugMonths.map((m) =>
        groupEntries.filter((e) => e.kind === 'plan' && !e.tentative && e.leaf_id === leaf && ymOf(e.date) === m).reduce((a, e) => a + e.amount * sign, 0),
      );
      const planUsed = planPer.filter((v, i) => v !== 0 && per[i] !== 0);
      const next = addMonths(ix.cur, 1);
      const plan = planUsed.length
        ? Math.round(planUsed.reduce((a, v) => a + v, 0) / planUsed.length)
        : planEntries.filter((e) => e.leaf_id === leaf && !e.tentative && ymOf(e.date) === next).reduce((a, e) => a + e.amount * sign, 0);
      // csak rendszeres költség/bevétel: van jövő havi terv, vagy legalább 2 hónapban volt tény
      if (!plan && used.length < 2) continue;
      const suggested = Math.ceil(avg / 1000) * 1000;
      const diff = avg - plan;
      const over = section === 'out' ? diff > Math.max(2000, plan * 0.05) : -diff > Math.max(2000, plan * 0.05);
      if (over) out.push({ leaf, avg, plan, suggested, diff });
    }
    return out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  })();

  const sugMap = new Map(suggest.map((x) => [x.leaf, x]));

  const renderActualRow = (leaf: string, r: ActRow) => (
    <div
      key={r.key}
      style={{ display: 'grid', gridTemplateColumns: gridCols, minWidth: minW, alignItems: 'center', borderTop: `1px solid ${C.line3}`, background: C.bg3 }}
    >
      <div />
      <div style={{ padding: '8px 8px 8px 26px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ font: `500 13.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
        <span style={{ font: `400 11.5px ${FONT}`, color: C.muted }}>
          tény, terv nélkül · {r.count} tétel
          {r.recurring >= 3 && !r.planned ? ` · ${r.recurring} hónapja ismétlődik, nincs beütemezve` : ''}
        </span>
      </div>
      <div style={{ padding: '0 8px' }}>
        {canEdit && !r.planned && !r.merged && (
          <button
            onClick={() => {
              // havi terv a következő hónaptól 12 hónapra (az eddigi összeggel és fizetési nappal), majd megnyílik a
              // tételszerkesztő: ott állítható az ismétlődés, a fizetés napja, a kezdés és az utolsó hónap
              const last = actualsIn
                .filter((e) => e.leaf_id === leaf && nz(e.name) === nz(r.name))
                .reduce<Entry | null>((x, e) => (!x || e.date > x.date ? e : x), null);
              const amount = r.recurring >= 3 ? r.avg : Math.abs(last?.amount || r.byMonth[Object.keys(r.byMonth).sort().pop() || ''] || 0);
              const b = genSeries({
                leaf,
                section,
                name: planNameOf(r.name),
                amount,
                startYm: addMonths(ix.cur, 1),
                count: 12,
                rep: 'monthly',
                day: Number(last?.date.slice(8)) || 10,
                payRule: ruleOf(ix, leaf),
              });
              commit(b, `${r.name}: beütemezve havonta ${fmt(amount)} Ft, 12 hónap – a szerkesztőben módosíthatod`);
              openModal(null, { key: b.series![0].id });
            }}
            title="Tervbe veszem: havonta, a következő hónaptól – utána a szerkesztőben beállíthatod a fizetés napját, az ismétlődést és hogy meddig tartson"
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '5px 10px', font: `600 11.5px ${FONT}`, cursor: 'pointer' }}
          >
            Beütemezés
          </button>
        )}
      </div>
      {months.map((m) => (
        <div key={m} style={{ padding: '6px 8px', textAlign: 'right', font: `600 12.5px ${FONT}`, color: C.blueDark, fontVariantNumeric: 'tabular-nums' }}>
          {r.byMonth[m] ? fmt(r.byMonth[m]) : ''}
        </div>
      ))}
      <div />
    </div>
  );

  const renderRow = (key: string, es: Entry[]) => {
    const des = delMap.get(key) || [];
    const head = es[0] || des[0];
    if (!es.length)
      return (
        <div
          key={key}
          style={{
            display: 'grid',
            gridTemplateColumns: gridCols,
            minWidth: minW,
            alignItems: 'center',
            borderTop: `1px solid ${C.line}`,
            background: C.bg3,
          }}
        >
          <div />
          <div style={{ padding: '10px 8px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span
              style={{
                font: `600 14px ${FONT}`,
                color: C.faint,
                textDecoration: 'line-through',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {head.name || ix.leafById[head.leaf_id]?.label}
            </span>
            <span style={{ font: `400 12px ${FONT}`, color: C.faint }}>
              <PartnerLink leaf={head.leaf_id}>{ix.leafById[head.leaf_id]?.label}</PartnerLink> · törölve
            </span>
          </div>
          <div style={{ padding: '0 8px' }}>
            {canEdit && (
              <button
                onClick={() => restore(des)}
                title="Az összes törölt hónap visszaállítása"
                style={{
                  border: `1px solid ${C.line2}`,
                  background: '#fff',
                  borderRadius: 999,
                  padding: '4px 10px',
                  font: `600 11.5px ${FONT}`,
                  color: C.blueDark,
                  cursor: 'pointer',
                }}
              >
                ↺ Mind vissza
              </button>
            )}
          </div>
          {months.map((m) => (
            <div key={m} style={{ padding: '6px 4px' }}>
              <DeletedCell ds={des.filter((d) => ymOf(d.date) === m)} sign={sign} canEdit={canEdit} onRestore={restore} />
            </div>
          ))}
          <div />
        </div>
      );
    const s = data.series.find((x) => x.id === es[0].series_id);
    const openEs = es.filter((e) => !e.done && visibleSet.has(ymOf(e.date)));
    const allSel = openEs.length > 0 && openEs.every((e) => sel[e.id]);
    const anySel = openEs.some((e) => sel[e.id]);
    const typical = (openEs[0] || es[es.length - 1]).amount;
    const inferred: Rep = s?.rep || (es.length > 1 ? 'monthly' : 'once');
    const lastE = es.reduce((a, e) => (e.date > a.date ? e : a), es[0]);
    const lastYm = ymOf(lastE.date);
    const tentative = es.some((e) => e.tentative);
    const fromBillingo = es.some((e) => e.source === 'billingo');
    const day = s?.day || Number(es[0].date.slice(8));
    return (
      <div
        key={key}
        className="row-hover"
        style={{
          display: 'grid',
          gridTemplateColumns: gridCols,
          minWidth: minW,
          alignItems: 'center',
          borderTop: `1px solid ${C.line}`,
          background: anySel ? '#F7FAFD' : '#fff',
        }}
      >
        <div style={{ paddingLeft: 16, display: 'flex' }}>
          {canEdit && (
            <input
              type="checkbox"
              checked={allSel}
              onChange={() =>
                setSel((x) => {
                  const n = { ...x };
                  openEs.forEach((e) => (allSel ? delete n[e.id] : (n[e.id] = true)));
                  return n;
                })
              }
              style={{ width: 16, height: 16, accentColor: C.blue, cursor: 'pointer' }}
            />
          )}
        </div>
        <div
          onClick={() => canEdit && openModal(null, { key })}
          style={{ padding: '8px 8px 8px 26px', display: 'flex', flexDirection: 'column', cursor: canEdit ? 'pointer' : 'default', minWidth: 0 }}
          title="Szerkesztés"
        >
          <span style={{ font: `500 13.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {(() => {
              // havidíj-sorozat: az alapnév + mely hónapok („Havi díj · 2026. október – 2026. december”); egy hónapnál a teljes név
              const nm = itemLabel(es[0].name, ix.leafById[es[0].leaf_id]?.label || '') || es[0].name || ix.leafById[es[0].leaf_id]?.label || '';
              const ms = [...new Set(es.map((e) => e.period || ymOf(e.date)))].sort();
              return ms.length > 1 && hasMonth(nm) ? `${baseName(nm)} · ${monthLong(ms[0])} – ${monthLong(ms[ms.length - 1])}` : nm;
            })()}
          </span>
          <span style={{ font: `400 11.5px ${FONT}`, color: C.muted }}>
            fizetés:{' '}
            {inferred === 'once'
              ? `${monthLabel(ymOf(es[0].date))} ${day}.`
              : `${inferred === 'yearly' ? 'évente' : inferred === 'quarterly' ? '3 havonta' : 'minden hó'} ${day}.`}
          </span>
        </div>
        <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
          <span
            style={{
              display: 'inline-flex',
              font: `600 11.5px ${FONT}`,
              padding: '4px 10px',
              borderRadius: 999,
              background: inferred === 'once' ? C.bg : C.bg2,
              color: inferred === 'once' ? C.muted : C.blueDark,
            }}
          >
            {REP[inferred]}
          </span>
          {tentative && <span style={{ font: `600 10.5px ${FONT}`, color: '#8A6D1C' }}>ajánlat</span>}
          {fromBillingo && <span style={{ font: `600 10.5px ${FONT}`, color: C.blueDark }}>Billingo számla</span>}
        </div>
        {months.map((m) => {
          const list = es.filter((e) => ymOf(e.date) === m);
          const dl = des.filter((d) => ymOf(d.date) === m);
          if (!list.length && dl.length)
            return (
              <div key={m} style={{ padding: '6px 4px' }}>
                <DeletedCell ds={dl} sign={sign} canEdit={canEdit} onRestore={restore} />
              </div>
            );
          if (!list.length && canEdit && inferred !== 'once' && m === addMonths(lastYm, repStep(inferred)))
            return (
              <div key={m} style={{ padding: '6px 4px' }}>
                <ContinueBtn
                  onExtend={(n) => commit(extendRows(data, [lastE.id], n), `${itemLabel(lastE.name, '') || 'Sorozat'} folytatva ${n} hónappal`)}
                  onEdit={() => openModal(null, { key })}
                />
              </div>
            );
          if (!list.length)
            return (
              <div key={m} style={{ padding: '6px 4px' }}>
                <button
                  disabled={!canEdit}
                  title={`Kattints: ${fmt(Math.abs(typical))} Ft ide másolása`}
                  onClick={() => {
                    const src = es[es.length - 1];
                    commit(
                      {
                        upsert: [
                          {
                            ...src,
                            name: planNameOf(src.name),
                            id: uid('e'),
                            updated_at: undefined,
                            date: dateIn(m, Number(src.date.slice(8))),
                            done: 0,
                            link_id: null,
                            ext_ref: null,
                            source: 'manual',
                            amount: typical,
                          },
                        ],
                      },
                      `${src.name || 'Tétel'} bemásolva: ${monthLabel(m)}`,
                    );
                  }}
                  className="cell-empty"
                  style={{
                    width: '100%',
                    height: 30,
                    borderRadius: 8,
                    border: `1px dashed ${C.line}`,
                    background: 'transparent',
                    cursor: canEdit ? 'pointer' : 'default',
                  }}
                />
              </div>
            );
          const amt = list.reduce((a, e) => a + e.amount * sign, 0);
          const done = list.every((e) => e.done);
          const isSel = list.some((e) => sel[e.id]);
          const d = list[0].date.slice(8).replace(/^0/, '') + '.';
          const overdue = !done && list[0].date < data.today;
          // teljesült terv: a hozzá kötött tény összege – ha eltér (≥ 1 000 Ft és 1%), piros
          const acts = list.map((e) => (e.done && e.link_id ? actualById.get(e.link_id) : undefined));
          const actAmt = acts.every(Boolean) ? acts.reduce((a, x) => a + x!.amount * sign, 0) : null;
          const dev = done && actAmt !== null && Math.abs(actAmt - amt) >= Math.max(1000, Math.abs(amt) * 0.01) ? actAmt - amt : 0;
          // terv vs tény: több bevétel (kevesebb kiadás) zöld, pontos kék, kevesebb bevétel (több kiadás) piros
          const better = dev !== 0 && (section === 'in' ? dev > 0 : dev < 0);
          const red = overdue || (dev !== 0 && !better);
          const green = !overdue && better;
          return (
            <div key={m} style={{ padding: '6px 4px' }}>
              <div
                style={{
                  width: '100%',
                  height: 30,
                  borderRadius: 8,
                  border: `1px solid ${isSel ? C.blue : red ? C.neg : green ? GOOD : done ? C.blue : C.line2}`,
                  background: isSel ? C.blue : red ? C.negBg : green ? GOOD_BG : done ? '#fff' : C.bg2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  paddingLeft: 4,
                }}
              >
                {canEdit && (
                  <button
                    title={done ? 'Kész – kattintás: visszaállítás nyitottra' : 'Kipipálás: kész'}
                    onClick={() =>
                      commit(
                        markDone(
                          data,
                          list.map((e) => e.id),
                          !done,
                        ),
                        `${list.length} tétel ${!done ? 'késznek jelölve ✓' : 'visszaállítva nyitottra'}`,
                      )
                    }
                    style={{
                      width: 18,
                      height: 18,
                      flex: 'none',
                      borderRadius: 999,
                      border: `1.5px solid ${done ? C.blue : isSel ? '#fff' : C.muted2}`,
                      background: done ? C.blue : '#fff',
                      color: done ? '#fff' : C.blue,
                      font: `700 10px/1 ${FONT}`,
                      padding: 0,
                      cursor: 'pointer',
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  >
                    {done ? '✓' : ''}
                  </button>
                )}
                <button
                  onClick={() =>
                    !done &&
                    canEdit &&
                    setSel((x) => {
                      const n = { ...x };
                      list.filter((e) => !e.done).forEach((e) => (isSel ? delete n[e.id] : (n[e.id] = true)));
                      return n;
                    })
                  }
                  title={
                    dev
                      ? `Eltérés: terv ${fmt(amt)} → tény ${fmt(actAmt || 0)} Ft (${dev > 0 ? '+' : '−'}${fmt(Math.abs(dev))})`
                      : done
                        ? 'Teljesült'
                        : overdue
                          ? 'Lejárt, még nyitott – nem érkezett banki tény'
                          : 'Kattints a kijelöléshez'
                  }
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: '100%',
                    border: 0,
                    background: 'transparent',
                    color: isSel ? '#fff' : red ? C.neg : green ? GOOD : done ? C.blueDark : C.navy,
                    font: `600 12.5px ${FONT}`,
                    fontVariantNumeric: 'tabular-nums',
                    cursor: 'pointer',
                    padding: '0 6px 0 2px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 4,
                  }}
                >
                  <span style={{ font: `500 10.5px ${FONT}`, opacity: 0.7 }}>{d}</span>
                  <span>{fmt(dev ? actAmt || 0 : amt)}</span>
                </button>
              </div>
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {canEdit && (
            <button
              onClick={() => openModal(null, { key })}
              title="Szerkesztés"
              className="icon-btn"
              style={{
                width: 30,
                height: 30,
                border: 0,
                borderRadius: 8,
                background: 'transparent',
                color: C.muted,
                cursor: 'pointer',
                font: `600 15px ${FONT}`,
              }}
            >
              ✎
            </button>
          )}
        </div>
      </div>
    );
  };

  const gridCols = `44px minmax(220px,1.5fr) 118px repeat(${months.length},minmax(156px,1fr)) 48px`;
  const minW = 450 + months.length * 116;

  return (
    <div style={{ padding: '28px 32px 140px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>
            {section === 'in' ? 'Bevétel' : 'Kiadás'} · kategória
          </div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy, letterSpacing: '-.01em' }}>{displayGroup(G.label)}</h1>
        </div>
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {[
            ['Terv (látható hónapok)', planSum, C.navy],
            ['Ebből nyitott', openSum, C.navy],
            ['Tény (időszak)', actSum, C.blue],
          ].map(([l, v, c]) => (
            <div key={l as string} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={eyebrow}>{l}</span>
              <span style={{ font: `800 22px ${FONT_H}`, color: c as string, fontVariantNumeric: 'tabular-nums' }}>{fmt(v as number)}</span>
            </div>
          ))}
        </div>
      </div>

      {canEdit && (
        <div
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && qaSave()}
          style={{ ...card, padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}
        >
          <span style={{ font: `700 13px ${FONT_H}`, color: C.navy, marginRight: 4 }}>Gyors felvitel</span>
          <input
            value={qa.name}
            onChange={(e) => setQa({ ...qa, name: e.target.value })}
            placeholder="Megnevezés"
            style={{ ...inputStyle, flex: '1 1 180px', minWidth: 150 }}
          />
          <input
            value={qa.amount}
            inputMode="numeric"
            onChange={(e) => setQa({ ...qa, amount: e.target.value.replace(/[^\d ]/g, '') })}
            placeholder="Összeg (Ft)"
            style={{ ...inputStyle, width: 130, textAlign: 'right', fontWeight: 600 }}
          />
          <NetBox value={qa.amount} onChange={(g) => setQa({ ...qa, amount: g })} small />
          <select value={qaLeaf} onChange={(e) => setQa({ ...qa, leaf: e.target.value })} style={inputStyle}>
            <option value={NEW}>+ Új {newWord}…</option>
            {ix.leaves
              .filter((l) => l.group_id === groupId && !l.archived)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
          </select>
          {qaLeaf === NEW && (
            <input
              autoFocus
              value={qa.newLeaf}
              onChange={(e) => setQa({ ...qa, newLeaf: e.target.value })}
              placeholder={`Új ${newWord} neve`}
              autoCapitalize="sentences"
              style={{ ...inputStyle, width: 190, borderColor: C.blue }}
            />
          )}
          <select value={qa.m} onChange={(e) => setQa({ ...qa, m: e.target.value })} style={inputStyle}>
            {monthRange(ix.cur, addMonths(ix.cur, 17)).map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)} {m.slice(0, 4)}
              </option>
            ))}
          </select>
          <Seg
            small
            value={qa.rep}
            onChange={(v) => setQa({ ...qa, rep: v })}
            options={[
              ['once', 'Egyszeri'],
              ['monthly', 'Havonta'],
              ['quarterly', '3 havonta'],
              ['yearly', 'Évente'],
            ]}
          />
          {qa.rep !== 'once' && (
            <select value={qa.count} onChange={(e) => setQa({ ...qa, count: Number(e.target.value) })} style={inputStyle}>
              <option value={3}>3 hónapig</option>
              <option value={6}>6 hónapig</option>
              <option value={12}>12 hónapig</option>
              <option value={24}>24 hónapig</option>
            </select>
          )}
          <button
            className="hov-dark"
            onClick={qaSave}
            style={{
              height: 38,
              border: 0,
              borderRadius: 999,
              background: C.navy,
              color: '#fff',
              padding: '0 18px',
              font: `600 13.5px ${FONT}`,
              cursor: 'pointer',
            }}
          >
            Hozzáad ↵
          </button>
        </div>
      )}

      {months.length > 0 ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {(
              [
                ['‹ Előző hónap', -1],
                ['Következő hónap ›', 1],
              ] as [string, number][]
            ).map(([l, d]) => (
              <button
                key={l}
                onClick={() => setFilters({ from: addMonths(filters.from, d), to: addMonths(filters.to, d) })}
                style={{
                  border: `1px solid ${C.line2}`,
                  background: '#fff',
                  borderRadius: 999,
                  padding: '7px 14px',
                  font: `600 13px ${FONT}`,
                  color: C.navy,
                  cursor: 'pointer',
                }}
              >
                {l}
              </button>
            ))}
            {filters.from !== ix.cur && (
              <button
                onClick={() => setFilters({ from: ix.cur, to: addMonths(ix.cur, Math.max(1, monthRange(filters.from, filters.to).length - 1)) })}
                style={{ border: 0, background: C.bg2, borderRadius: 999, padding: '7px 14px', font: `600 13px ${FONT}`, color: C.blueDark, cursor: 'pointer' }}
              >
                Vissza a mai hónaphoz
              </button>
            )}
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
              Partnerre kattintva lenyílnak a feladatai · a múlt hónapokban a tény látszik, alatta a terv
            </span>
            <ShowDeletedToggle count={(data.deleted || []).filter((d) => leafIds.has(d.leaf_id) && visibleSet.has(ymOf(d.date))).length} />
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', font: `400 12.5px ${FONT}`, color: C.muted, alignItems: 'center' }}>
            <Legend bg={C.bg2} border={`1px solid ${C.line2}`} text="tervezett — ○ pipálás: kész · összegre kattintás: kijelölés" />
            <Legend bg={C.blue} text="kijelölt" />
            <Legend bg="#fff" border={`1px solid ${C.blue}`} text="✓ kész (kézzel vagy bankból)" />
            <Legend bg={GOOD_BG} border={`1px solid ${GOOD}`} text={section === 'in' ? 'több, mint a terv' : 'kevesebb, mint a terv'} />
            <Legend bg={C.negBg} border={`1px solid ${C.neg}`} text={section === 'in' ? 'kevesebb / lejárt' : 'több / lejárt'} />
            <Legend bg="transparent" border={`1px dashed ${C.line2}`} text="üres — kattintás: tétel ide másolása" />
          </div>
          {suggest.length > 0 && (
            <div style={{ ...card, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${C.neg}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <b style={{ font: `700 15px ${FONT_H}`, color: C.neg }}>▲ Tartós túllépés várható</b>
                <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                  a terv nem változik, csak jelzés: az elmúlt hónapok ({monthLabel(sugMonths[0])}–{monthLabel(sugMonths[sugMonths.length - 1])}) tényleges
                  átlaga több, mint a terv · a táblázatban „≈ várható” · összesen +{fmt(suggest.reduce((a, x) => a + Math.abs(x.diff), 0))} Ft / hó
                </span>
              </div>
              {suggest.map((x) => (
                <div
                  key={x.leaf}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    font: `500 13px ${FONT}`,
                    borderTop: `1px solid ${C.line3}`,
                    paddingTop: 8,
                  }}
                >
                  <PartnerLink leaf={x.leaf} style={{ minWidth: 170, font: `700 13.5px ${FONT}`, color: C.navy }}>
                    {ix.leafById[x.leaf]?.label}
                  </PartnerLink>
                  <span style={{ color: C.muted }}>
                    tény átlag <b style={{ color: C.neg }}>{fmt(x.avg)}</b>/hó · terv átlag ugyanezekben a hónapokban{' '}
                    <b style={{ color: C.navy }}>{fmt(x.plan)}</b>
                  </span>
                  <span style={{ color: C.navy }}>
                    várható túllépés: <b style={{ color: C.neg }}>+{fmt(x.diff)} Ft/hó</b> (reális keret ≈ {fmt(x.suggested)})
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ ...card, overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, minWidth: minW, background: C.navy, color: '#fff', alignItems: 'center' }}>
              <div />
              <div style={{ padding: '12px 8px', font: `700 13px ${FONT_H}` }}>Partner · feladatok</div>
              <div style={{ padding: '12px 8px', font: `700 13px ${FONT_H}` }}>Ismétlődés</div>
              {months.map((m) => (
                <div key={m} style={{ padding: '10px 8px', textAlign: 'center', display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ font: `700 12.5px ${FONT_H}` }}>{monthLabel(m)}</span>
                  <span style={{ font: `500 10.5px ${FONT}`, color: C.muted2 }}>{m.slice(0, 4)}</span>
                </div>
              ))}
              <div />
            </div>
            {rows.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Ebben az időszakban nincs tervezett tétel.</div>
            )}
            {partners.map((leaf) => {
              const L = ix.leafById[leaf];
              const prows = rows.filter(([k, es]) => ((es[0] || (delMap.get(k) || [])[0]) as Entry | undefined)?.leaf_id === leaf);
              const extra = actualRows(leaf);
              const isOpen = !!openP[leaf];
              // a partner ismétlődő (nem ajánlat) sorozatai közül a legkésőbb végződők folytathatók a fejlécből is
              const recur = prows
                .map(([, es]) => es)
                .filter((es) => es.length && !es.some((e) => e.tentative))
                .map((es) => {
                  const last = es.reduce((a, e) => (e.date > a.date ? e : a), es[0]);
                  const rep = data.series.find((x) => x.id === es[0].series_id)?.rep || (es.length > 1 ? 'monthly' : 'once');
                  return { last, step: repStep(rep), once: rep === 'once' };
                })
                .filter((x) => !x.once);
              const maxYm = recur.reduce((a, x) => (ymOf(x.last.date) > a ? ymOf(x.last.date) : a), '');
              const contRows = recur.filter((x) => ymOf(x.last.date) === maxYm);
              const cont = contRows.map((x) => x.last);
              const contYm = contRows.length ? addMonths(maxYm, Math.min(...contRows.map((x) => x.step))) : '';
              // a sor alatt a következő számlázandó hónap tétele („Havi díj – 2026. november”), nem a legelső
              const nextOf = (es: Entry[]) => es.find((e) => !e.done && (e.period || ymOf(e.date)) >= ix.cur) || es.find((e) => !e.done) || es[es.length - 1];
              const names = [...new Set([...prows.map(([, es]) => itemLabel(nextOf(es)?.name || '', L?.label || '')), ...extra.map((x) => x.name)])].filter(
                Boolean,
              );
              return (
                <div key={leaf}>
                  <div
                    className="row-hover"
                    onClick={() => setOpenP((x) => ({ ...x, [leaf]: !x[leaf] }))}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: gridCols,
                      minWidth: minW,
                      alignItems: 'center',
                      borderTop: `1px solid ${C.line2}`,
                      background: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ paddingLeft: 14, font: `700 13px ${FONT}`, color: C.blueDark }}>{isOpen ? '▾' : '▸'}</div>
                    <div style={{ padding: '11px 8px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span
                        role="button"
                        title="Partner adatlapja"
                        className="partner-link"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          openPartner(leaf);
                        }}
                        style={{
                          font: `700 15px ${FONT}`,
                          color: C.navy,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          cursor: 'pointer',
                        }}
                      >
                        {L?.label || '—'}
                      </span>
                      <span style={{ font: `400 12px ${FONT}`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {names.join(' · ') || 'nincs tétel'}
                      </span>
                    </div>
                    <div style={{ padding: '0 8px', font: `600 11.5px ${FONT}`, color: C.blueDark, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span>{prows.length + extra.length} tétel</span>
                      {sugMap.get(leaf) && (
                        <span
                          title={`Tartós túllépés: a tényleges átlag ${fmt(sugMap.get(leaf)!.avg)} Ft/hó, a terv ${fmt(sugMap.get(leaf)!.plan)} Ft – a terv nem változik`}
                          style={{ color: C.neg, font: `700 11px ${FONT}` }}
                        >
                          ▲ +{fmt(sugMap.get(leaf)!.diff)}/hó
                        </span>
                      )}
                    </div>
                    {months.map((m) => {
                      const plan = leafPlan(leaf, m);
                      const offer = leafOffer(leaf, m);
                      const act = m <= ix.cur ? leafAct(leaf, m) : 0;
                      const hasAct = m <= ix.cur && act !== 0;
                      const bm = budgetOf(leaf, m);
                      if (bm && (bm.used > 0 || m <= ix.cur)) {
                        // keret: mennyi fogyott el belőle, mennyi maradt (megtakarítás) vagy mennyivel léptük túl
                        const rest = bm.budget - bm.used;
                        const over = rest < 0;
                        return (
                          <div key={m} style={{ padding: '6px 4px' }}>
                            <div
                              title={`keret ${fmt(bm.budget)} Ft · felhasználva ${fmt(bm.used)} Ft · ${over ? `túllépés ${fmt(-rest)}` : `maradt ${fmt(rest)}`} Ft`}
                              style={{
                                minHeight: 34,
                                borderRadius: 8,
                                padding: '3px 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                alignItems: 'flex-end',
                                lineHeight: 1.15,
                                border: `1px solid ${over ? C.neg : GOOD}`,
                                background: over ? C.negBg : GOOD_BG,
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              <b style={{ font: `700 12.5px ${FONT}`, color: over ? C.neg : GOOD }}>{fmt(bm.used)}</b>
                              <span style={{ font: `500 10px ${FONT}`, color: C.muted, whiteSpace: 'nowrap' }}>
                                keret {fmt(bm.budget)}
                                <b style={{ marginLeft: 4, color: over ? C.neg : GOOD }}>
                                  {over ? `▲ ${fmt(-rest)}` : `▼ ${fmt(rest)} ${m < ix.cur ? 'megtakarítás' : 'maradt'}`}
                                </b>
                              </span>
                            </div>
                          </div>
                        );
                      }
                      if (!plan && !hasAct && !offer)
                        return canEdit && cont.length && m === contYm ? (
                          <div key={m} style={{ padding: '6px 4px' }} onClick={(ev) => ev.stopPropagation()}>
                            <ContinueBtn
                              onExtend={(n) =>
                                commit(
                                  extendRows(
                                    data,
                                    cont.map((e) => e.id),
                                    n,
                                  ),
                                  `${L?.label || 'Partner'}: ${cont.length} sorozat folytatva ${n} hónappal`,
                                )
                              }
                              onEdit={() => setOpenP((o) => ({ ...o, [leaf]: true }))}
                            />
                          </div>
                        ) : (
                          <div key={m} />
                        );
                      if (!plan && !hasAct)
                        return (
                          <div key={m} style={{ padding: '6px 4px' }}>
                            <div
                              title={`ajánlat ${fmt(offer)} Ft (még nem biztos – a Terv sorban nincs benne)`}
                              style={{
                                height: 34,
                                borderRadius: 8,
                                padding: '0 8px',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                alignItems: 'flex-end',
                                lineHeight: 1.1,
                                border: '1px dashed #C9A94A',
                                background: '#FFF9E6',
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              <b style={{ font: `700 12.5px ${FONT}`, color: '#8A6D1C' }}>{fmt(offer)}</b>
                              <span style={{ font: `500 10px ${FONT}`, color: '#8A6D1C' }}>ajánlat</span>
                            </div>
                          </div>
                        );
                      const diff = act - plan;
                      const past = m < ix.cur;
                      const cmp = hasAct || past;
                      // terv nélküli (pl. régi) hónapban nincs mihez mérni: semleges
                      const judged = cmp && plan !== 0;
                      const good = judged && diff !== 0 && (section === 'in' ? diff > 0 : diff < 0);
                      const bad = judged && diff !== 0 && !good && Math.abs(diff) >= Math.max(1000, Math.abs(plan) * 0.01);
                      if (cmp)
                        // múlt / folyó hónap: két oszlop – bal a terv, jobb a tény (piros, ha rosszabb a tervnél: kiadásnál több,
                        // bevételnél kevesebb; zöld, ha jobb), alatta az eltérés ▲/▼
                        return (
                          <div
                            key={m}
                            style={{ padding: '6px 4px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}
                            title={`terv ${fmt(plan)} Ft · tény ${fmt(act)} Ft · különbség ${diff > 0 ? '+' : ''}${fmt(diff)} Ft`}
                          >
                            <div
                              style={{
                                minHeight: 34,
                                borderRadius: 8,
                                padding: '3px 6px',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                alignItems: 'flex-end',
                                lineHeight: 1.15,
                                background: C.bg2,
                                border: `1px solid ${C.line2}`,
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              <span style={{ font: `600 9px ${FONT}`, color: C.muted, letterSpacing: '.04em' }}>TERV</span>
                              <b style={{ font: `700 12px ${FONT}`, color: C.navy }}>{plan ? fmt(plan) : '–'}</b>
                            </div>
                            <div
                              style={{
                                minHeight: 34,
                                borderRadius: 8,
                                padding: '3px 6px',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'center',
                                alignItems: 'flex-end',
                                lineHeight: 1.15,
                                border: `1px solid ${bad ? C.neg : good ? GOOD : C.blue}`,
                                background: bad ? C.negBg : good ? GOOD_BG : '#fff',
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              <span style={{ font: `600 9px ${FONT}`, color: C.muted, letterSpacing: '.04em' }}>
                                TÉNY
                                {judged && diff !== 0 && (
                                  <b style={{ marginLeft: 3, color: good ? GOOD : bad ? C.neg : C.muted }}>
                                    {diff < 0 ? '▼' : '▲'}
                                    {fmt(Math.abs(diff))}
                                  </b>
                                )}
                              </span>
                              <b style={{ font: `700 12px ${FONT}`, color: bad ? C.neg : good ? GOOD : C.blueDark }}>{fmt(act)}</b>
                            </div>
                          </div>
                        );
                      return (
                        <div key={m} style={{ padding: '6px 4px' }}>
                          <div
                            title={`terv ${fmt(plan)} Ft${cmp ? ` · tény ${fmt(act)} Ft · különbség ${diff > 0 ? '+' : ''}${fmt(diff)} Ft` : ''}`}
                            style={{
                              minHeight: 34,
                              borderRadius: 8,
                              padding: '3px 8px',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'center',
                              alignItems: 'flex-end',
                              lineHeight: 1.15,
                              border: `1px solid ${bad ? C.neg : good ? GOOD : cmp ? C.blue : C.line2}`,
                              background: bad ? C.negBg : good ? GOOD_BG : cmp ? '#fff' : C.bg2,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            <b style={{ font: `700 12.5px ${FONT}`, color: bad ? C.neg : good ? GOOD : cmp ? C.blueDark : C.navy }}>{fmt(cmp ? act : plan)}</b>
                            {cmp && plan !== 0 && (
                              <span style={{ font: `500 10px ${FONT}`, color: C.muted, whiteSpace: 'nowrap' }}>
                                terv {fmt(plan)}
                                {diff !== 0 && (
                                  // eltérés a tervtől: ▼ kevesebb (csökkenés), ▲ több – kiadásnál a kevesebb a jó
                                  <b style={{ marginLeft: 4, color: good ? GOOD : bad ? C.neg : C.muted }}>
                                    {diff < 0 ? '▼' : '▲'} {fmt(Math.abs(diff))}
                                  </b>
                                )}
                              </span>
                            )}
                            {!cmp && plan !== 0 && sugMap.get(leaf) && (
                              <span style={{ font: `700 10px ${FONT}`, color: C.neg }}>≈ {fmt(sugMap.get(leaf)!.avg)} várható</span>
                            )}
                            {!cmp && offer !== 0 && <span style={{ font: `500 10px ${FONT}`, color: '#8A6D1C' }}>+ ajánlat {fmt(offer)}</span>}
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      {canEdit && (
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            openModal(leaf);
                          }}
                          title="Partner tételei"
                          className="icon-btn"
                          style={{
                            width: 30,
                            height: 30,
                            border: 0,
                            borderRadius: 8,
                            background: 'transparent',
                            color: C.muted,
                            cursor: 'pointer',
                            font: `600 15px ${FONT}`,
                          }}
                        >
                          ✎
                        </button>
                      )}
                    </div>
                  </div>
                  {isOpen && prows.map(([key, es]) => renderRow(key, es))}
                  {isOpen && extra.map((x) => renderActualRow(leaf, x))}
                </div>
              );
            })}
            {/* havi összesítő: terv, tény és a kettő különbsége */}
            {(
              [
                ['Terv (biztos)', (m: string) => monthPlan(m), C.navy],
                ...(months.some((m) => monthOffer(m) !== 0)
                  ? ([
                      ['Ajánlat (nem biztos)', (m: string) => monthOffer(m) || null, '#8A6D1C'],
                      ['Terv + ajánlat', (m: string) => monthPlan(m) + monthOffer(m), C.navy],
                    ] as [string, (m: string) => number | null, string | null][])
                  : []),
                ['Tény', (m: string) => (m <= ix.cur || pa.linked.get(m) ? (pa.linked.get(m) || 0) + (pa.other.get(m) || 0) : null), C.blue],
                ['Különbség', (m: string) => (m <= ix.cur ? (pa.linked.get(m) || 0) + (pa.other.get(m) || 0) - monthPlan(m) : null), null],
                ...(months.some((m) => m <= ix.cur && pa.other.get(m))
                  ? ([['ebből terv nélküli tény', (m: string) => (m <= ix.cur ? pa.other.get(m) || 0 : null), C.muted]] as [
                      string,
                      (m: string) => number | null,
                      string | null,
                    ][])
                  : []),
              ] as [string, (m: string) => number | null, string | null][]
            ).map(([label, f, col], i) => (
              <div
                key={label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridCols,
                  minWidth: minW,
                  alignItems: 'center',
                  borderTop: i === 0 ? `2px solid ${C.line2}` : `1px solid ${C.line}`,
                  background: C.bg,
                }}
              >
                <div />
                <div style={{ padding: '10px 8px', font: `700 13px ${FONT_H}`, color: C.navy }}>{label}</div>
                <div style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>{label === 'Különbség' ? 'tény − terv (▼ kevesebb, ▲ több)' : ''}</div>
                {months.map((m) => {
                  const v = f(m);
                  const c = col || (v === null || v === 0 ? C.blueDark : (section === 'in' ? v > 0 : v < 0) ? GOOD : C.neg);
                  return (
                    <div key={m} style={{ padding: '10px 8px', textAlign: 'center', font: `700 12.5px ${FONT}`, color: c, fontVariantNumeric: 'tabular-nums' }}>
                      {v === null ? '' : (label === 'Különbség' && v > 0 ? '+' : '') + fmt(v)}
                    </div>
                  );
                })}
                <div />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ ...card, padding: 18, font: `500 13.5px ${FONT}`, color: C.muted }}>
          A kiválasztott időszak a múltban van – lent a tényleges tételeket látod. Tervekhez válassz jövőbeli időszakot.
        </div>
      )}

      <div style={{ ...card, overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            borderBottom: `1px solid ${C.line}`,
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => setFactsOpen(!factsOpen)}
            style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: `700 15px ${FONT_H}`, color: C.navy }}
          >
            {factsOpen ? '▾' : '▸'} Tények a szűrt időszakban
          </button>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
              {actuals.length} tétel · {fmt(actSum)} Ft
            </span>
            <button
              onClick={() => setFactsOpen(!factsOpen)}
              style={{
                border: `1px solid ${C.line2}`,
                background: '#fff',
                borderRadius: 999,
                padding: '4px 12px',
                font: `600 12px ${FONT}`,
                color: C.blueDark,
                cursor: 'pointer',
              }}
            >
              {factsOpen ? 'Becsukás' : 'Kinyitás'}
            </button>
          </span>
        </div>
        {factsOpen && actuals.length === 0 && (
          <div style={{ padding: 20, color: C.muted, font: `500 13.5px ${FONT}` }}>Nincs tényleges tétel ebben az időszakban.</div>
        )}
        {(factsOpen ? (showAll ? actuals : actuals.slice(0, 60)) : []).map((e) => (
          <div
            key={e.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '90px minmax(0,1fr) minmax(160px,240px) 120px 40px',
              gap: 10,
              alignItems: 'center',
              padding: '9px 18px',
              borderTop: `1px solid ${C.line3}`,
            }}
          >
            <span style={{ font: `600 12.5px ${FONT}`, color: C.muted }}>{e.date.replace(/-/g, '.')}.</span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ font: `600 13.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.name || '—'}
              </span>
              <span style={{ font: `400 11.5px ${FONT}`, color: C.muted }}>
                {{ import: 'xls import', bank: 'bankból', manual: 'kézi', billingo: 'Billingo' }[e.source] || e.source}
                <PlanDiff actual={e} plan={planOfActual.get(e.id)} sec={section} />
              </span>
            </span>
            {canEdit ? (
              <LeafSelect
                ix={ix}
                section={section}
                value={e.leaf_id}
                onChange={(v) => commit({ upsert: [{ ...e, leaf_id: v }] }, `Átsorolva: ${ix.leafById[v].label}`)}
                style={{ height: 32, fontSize: 12.5 }}
              />
            ) : (
              <PartnerLink leaf={e.leaf_id} style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
                {ix.leafById[e.leaf_id]?.label}
              </PartnerLink>
            )}
            <span style={{ textAlign: 'right', font: `700 13.5px ${FONT}`, color: e.amount * sign < 0 ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(e.amount * sign)}
            </span>
            {canEdit ? (
              <button
                title="Törlés"
                onClick={() => confirm('Törlöd ezt a tényleges tételt?') && commit({ delete: [e.id] }, 'Tétel törölve')}
                className="icon-btn"
                style={{ border: 0, background: 'transparent', color: C.muted, cursor: 'pointer', font: `600 14px ${FONT}` }}
              >
                ×
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
        {factsOpen && !showAll && actuals.length > 60 && (
          <button
            onClick={() => setShowAll(true)}
            style={{
              width: '100%',
              border: 0,
              borderTop: `1px solid ${C.line}`,
              background: C.bg3,
              padding: 12,
              color: C.blueDark,
              font: `600 13px ${FONT}`,
              cursor: 'pointer',
            }}
          >
            Mind a {actuals.length} tétel mutatása
          </button>
        )}
      </div>

      {selCal &&
        (() => {
          const es = data.entries.filter((e) => sel[e.id] && !e.done).sort((a, b) => a.date.localeCompare(b.date));
          if (!es.length) return null;
          return (
            <CalendarSheet
              value={es[0].date}
              onClose={() => setSelCal(false)}
              onPick={(v) => {
                setSelCal(false);
                // egy tételnél pontosan erre a napra; többnél az első kerül ide, a többi ugyanannyi nappal tolódik
                const d = Math.round((Date.parse(v) - Date.parse(es[0].date)) / 86400000);
                if (!d) return;
                const ups = es.map((e) => ({ ...e, date: new Date(Date.parse(e.date) + d * 86400000).toISOString().slice(0, 10) }));
                commit(
                  { upsert: ups },
                  ups.length === 1
                    ? `${ups[0].name || 'Tétel'}: fizetés ${v.replace(/-/g, '.')}.`
                    : `${ups.length} tétel fizetése ${d > 0 ? '+' : ''}${d} nappal`,
                );
                clear();
              }}
            />
          );
        })()}
      {selIds.length > 0 && (
        <div style={{ position: 'sticky', bottom: 20, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div
            style={{
              pointerEvents: 'auto',
              background: C.navy,
              color: '#fff',
              borderRadius: 999,
              padding: '8px 8px 8px 20px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 2px 4px rgba(0,32,64,.06),0 24px 48px rgba(0,32,64,.22)',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ font: `600 13.5px ${FONT}`, marginRight: 6 }}>
              {selIds.length === 1 ? data.entries.find((e) => e.id === selIds[0])?.name || '1 tétel' : `${selIds.length} tétel`} · {fmt(selSum)} Ft
            </span>
            <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,.15)' }} />
            <SelAmount
              key={selIds.join()}
              onSave={(v) => {
                const ups = data.entries.filter((e) => sel[e.id]).map((e) => ({ ...e, amount: signed(ix.sectionOf(e.leaf_id), v) }));
                commit({ upsert: ups }, `${ups.length} tétel összege: ${fmt(v)} Ft`);
                clear();
              }}
            />
            <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,.15)' }} />
            <span style={{ ...eyebrow, color: C.muted2, margin: '0 4px 0 6px' }}>Áthelyezés</span>
            <button onClick={() => setSelCal(true)} style={selBtn(C.blue)} title="A fizetés pontos napja (naptár)">
              📅 Fizetés napja
            </button>
            {[-1, 1].map((n) => (
              <button
                key={n}
                onClick={() => (commit(shiftEntries(data, selIds, n), `${selIds.length} tétel áthelyezve ${n > 0 ? '+' : ''}${n} hónappal`), clear())}
                style={selBtn(n < 0 ? C.navy3 : C.blue)}
              >
                {n > 0 ? '+' : '−'}
                {Math.abs(n)} hó
              </button>
            ))}
            <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,.15)' }} />
            <button onClick={() => (commit(extendRows(data, selIds), 'Sorozat meghosszabbítva 3 hónappal'), clear())} style={selBtn(C.navy3)}>
              Sorozat +3 hó
            </button>
            <button
              onClick={() => (commit(markDone(data, selIds, true), `${selIds.length} tétel késznek jelölve ✓`), clear())}
              style={{ ...selBtn('#fff'), color: C.navy }}
            >
              ✓ Kész
            </button>
            <button
              onClick={() => (commit(deleteEntries(data, selIds), `${selIds.length} tétel törölve`), clear())}
              style={{ ...selBtn('transparent'), color: C.negLight }}
            >
              Törlés
            </button>
            <button onClick={clear} style={{ ...selBtn('transparent'), color: C.muted2, width: 34, padding: 0 }}>
              ×
            </button>
          </div>
        </div>
      )}
      {offerGroup && (
        <div style={{ ...card, padding: 14 }}>
          <RejectedOffers leafIds={[...leafIds]} showLeaf />
        </div>
      )}
    </div>
  );
}

/** Lebegő sáv: a kijelölt tétel(ek) új összege – beírás + Enter. */
function SelAmount({ onSave }: { onSave: (v: number) => void }) {
  const [v, setV] = useState('');
  const n = parseWholeForint(v) || 0;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ ...eyebrow, color: C.muted2, margin: '0 0 0 6px' }}>Összeg</span>
      <input
        value={v}
        inputMode="numeric"
        placeholder="új összeg"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && n > 0 && onSave(n)}
        style={{
          width: 110,
          height: 34,
          borderRadius: 999,
          border: 0,
          padding: '0 12px',
          textAlign: 'right',
          font: `600 13px ${FONT}`,
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      {n > 0 && (
        <button onClick={() => onSave(n)} style={selBtn(C.blue)}>
          Mentés
        </button>
      )}
    </span>
  );
}

const selBtn = (bg: string): React.CSSProperties => ({
  border: 0,
  borderRadius: 999,
  background: bg,
  color: '#fff',
  padding: '9px 13px',
  font: `600 13px ${FONT}`,
  cursor: 'pointer',
  height: 34,
});

function Legend({ bg, border, text }: { bg: string; border?: string; text: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <i style={{ width: 12, height: 12, borderRadius: 4, background: bg, border }} />
      {text}
    </span>
  );
}

/** Törölt terv a havi cellában: áthúzva, ↺ visszaállítással. */
function DeletedCell({ ds, sign, canEdit, onRestore }: { ds: DeletedEntry[]; sign: number; canEdit: boolean; onRestore: (ds: DeletedEntry[]) => void }) {
  if (!ds.length) return <div style={{ height: 30 }} />;
  const amt = ds.reduce((a, d) => a + d.amount * sign, 0);
  return (
    <button
      disabled={!canEdit}
      onClick={() => onRestore(ds)}
      title={`Törölve ${new Date(ds[0].deleted_at).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })} – kattints a visszaállításhoz`}
      style={{
        width: '100%',
        height: 30,
        borderRadius: 8,
        border: `1px dashed ${C.line2}`,
        background: 'transparent',
        color: C.faint,
        font: `600 12.5px ${FONT}`,
        fontVariantNumeric: 'tabular-nums',
        cursor: canEdit ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 6px',
        gap: 4,
      }}
    >
      <span style={{ font: `700 12px ${FONT}`, color: C.blueDark }}>{canEdit ? '↺' : ''}</span>
      <span style={{ textDecoration: 'line-through' }}>{fmt(amt)}</span>
    </button>
  );
}

/**
 * A sorozat utolsó tétele utáni első üres hónap: folytatás választott hosszal (+3 … +24 hó, ugyanazzal az összeggel és
 * fizetési nappal), vagy „Beállítás…”: a tétel szerkesztője (fizetés napja, kezdés, utolsó hónap).
 */
function ContinueBtn({ onExtend, onEdit }: { onExtend: (months: number) => void; onEdit?: () => void }) {
  const [open, setOpen] = useState(false);
  const opt = (label: string, fn: () => void) => (
    <button
      key={label}
      onClick={() => (setOpen(false), fn())}
      style={{ border: 0, background: 'transparent', textAlign: 'left', padding: '7px 12px', font: `600 12.5px ${FONT}`, color: C.navy, cursor: 'pointer' }}
      className="side-opt"
    >
      {label}
    </button>
  );
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((x) => !x)}
        title="A terv folytatása: hány hónapra, vagy a tétel beállításai (fizetés napja, utolsó hónap)"
        style={{
          width: '100%',
          height: 34,
          borderRadius: 8,
          border: `1px dashed ${C.blue}`,
          background: '#F2F8FC',
          color: C.blue,
          font: `700 12px ${FONT}`,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        ↻ Folytatás
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          style={{
            position: 'absolute',
            zIndex: 20,
            top: 38,
            left: 0,
            minWidth: 170,
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            border: `1px solid ${C.line2}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,30,60,.15)',
            padding: '4px 0',
          }}
        >
          {[3, 6, 12, 24].map((n) => opt(`+${n} hónap`, () => onExtend(n)))}
          {onEdit && opt('Fizetés napja, utolsó hónap…', onEdit)}
        </div>
      )}
    </div>
  );
}
