// Egy beérkezett banki tétel jóváhagyó kártyája: megnevezés, kategória, terv-párosítás, ismétlődés – legördülő és felugró ablak nélkül.
import { useMemo, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { fmt, monthLabel, ymOf } from '../../shared/model';
import type { BankTx, Entry, Rep } from '../../shared/types';
import { api } from './api';
import { repStep, shiftDate } from './logic';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, card, inputStyle, shortDate } from './ui';

const chip = (active: boolean, accent = C.blue): React.CSSProperties => ({
  border: `1px solid ${active ? accent : C.line2}`,
  borderRadius: 999,
  padding: '6px 12px',
  font: `600 12.5px ${FONT}`,
  cursor: 'pointer',
  background: active ? accent : '#fff',
  color: active ? '#fff' : C.ink,
  whiteSpace: 'nowrap',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const labelBase: React.CSSProperties = {
  font: `600 10.5px ${FONT}`,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: C.muted,
  minWidth: 92,
  paddingTop: 8,
};
const row: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' };
const chips: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: 1, minWidth: 0 };

export function TxCard({ t, frequent, unforeseen, mobile }: { t: BankTx; frequent: string[]; unforeseen: string | null; mobile?: boolean }) {
  // telefonon a címke a gombok fölé kerül
  const label: React.CSSProperties = mobile ? { ...labelBase, minWidth: 0, width: '100%', paddingTop: 0 } : labelBase;
  const { ix, data, run, canEdit, showToast } = useStore();
  const section = t.amount >= 0 ? 'in' : 'out';
  const byId = useMemo(() => new Map(data.entries.map((e) => [e.id, e])), [data.entries]);
  const [leaf, setLeaf] = useState<string | null>(t.leaf_id || (section === 'out' ? unforeseen : null));
  // csak az azonos kategóriájú javasolt terv legyen előre kiválasztva
  const [plan, setPlan] = useState<string | null>(() => {
    const p = t.plan_id ? data.entries.find((e) => e.id === t.plan_id) : null;
    return p && (!t.leaf_id || p.leaf_id === t.leaf_id) ? p.id : null;
  });
  /** kategória váltáskor a másik kategóriához tartozó terv kikerül a kijelölésből */
  const pickLeaf = (id: string) => {
    setLeaf(id);
    const p = plan ? data.entries.find((e) => e.id === plan) : null;
    if (p && p.leaf_id !== id) setPlan(null);
  };
  const [name, setName] = useState(t.partner || t.memo || '');
  const [rep, setRep] = useState<Rep>('once');
  const [count, setCount] = useState(12);
  const [catQ, setCatQ] = useState('');
  const [planQ, setPlanQ] = useState('');
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null);
  const acc = data.accounts.find((a) => a.id === t.account_id);
  const planE = plan ? byId.get(plan) : null;
  const diff = planE ? Math.abs(t.amount) - Math.abs(planE.amount) : 0;
  const dup = data.entries.find((e) => e.kind === 'actual' && e.amount === t.amount && Math.abs(Date.parse(e.date) - Date.parse(t.date)) <= 5 * 86400000);

  // --- kategória gombok ---
  const sectionLeaves = ix.leaves.filter((l) => !l.archived && ix.sectionOf(l.id) === section);
  const q = normalizeText(catQ);
  const leafChips = q
    ? sectionLeaves.filter((l) => normalizeText(l.label + ' ' + (ix.groupById[l.group_id]?.label || '')).includes(q)).slice(0, 14)
    : [...new Set([leaf, section === 'out' ? unforeseen : null, ...frequent].filter(Boolean) as string[])]
        .map((id) => ix.leafById[id])
        .filter((l) => l && ix.sectionOf(l.id) === section)
        .slice(0, 7);
  const exact = q && sectionLeaves.some((l) => normalizeText(l.label) === q);

  // --- terv gombok ---
  const allPlans = data.entries.filter((e) => e.kind === 'plan' && !e.done && Math.sign(e.amount) === Math.sign(t.amount));
  const pq = normalizeText(planQ);
  const planChips: Entry[] = pq
    ? allPlans.filter((e) => normalizeText(e.name + ' ' + (ix.leafById[e.leaf_id]?.label || '')).includes(pq)).slice(0, 10)
    : allPlans
        .map((e) => ({
          e,
          dd: Math.abs(Date.parse(t.date) - Date.parse(e.date)) / 86400000,
          da: Math.abs(Math.abs(e.amount) - Math.abs(t.amount)) / Math.max(1, Math.abs(t.amount)),
        }))
        .filter((x) => x.dd <= 60)
        .sort(
          (a, b) =>
            Number(b.e.id === plan) - Number(a.e.id === plan) || Number(b.e.leaf_id === leaf) - Number(a.e.leaf_id === leaf) || a.da - b.da || a.dd - b.dd,
        )
        .slice(0, 4)
        .map((x) => x.e);

  const step = repStep(rep);
  const n = rep === 'once' ? 0 : Math.ceil(count / step);
  const nextDates = rep === 'once' ? [] : [1, 2, 3].slice(0, n).map((i) => shiftDate(t.date, i * step));

  const createLeaf = async (groupId: string) => {
    try {
      const r = await api<{ id: string }>('/api/leaves', { body: { group_id: groupId, label: catQ.trim() } });
      await run(async () => {});
      pickLeaf(r.id);
      setCatQ('');
      setNewGroupFor(null);
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };

  const approve = () => {
    if (!leaf) return showToast({ msg: 'Válassz kategóriát.', error: true });
    const item = { id: t.id, leaf_id: leaf, plan_id: plan, name, rep, count };
    run(
      () => api('/api/bank/approve', { body: { items: [item] } }),
      `Tény rögzítve: ${name} · ${fmt(t.amount)} Ft${plan ? ' · terv lezárva' : ''}${n ? ` · ${n} ismétlődő terv` : ''}`,
      () => api('/api/bank/unapprove', { body: { ids: [t.id] } }),
    );
  };

  return (
    <div style={{ ...card, padding: mobile ? 14 : '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ font: `600 15px ${FONT}`, color: C.navy }}>{t.partner || '(ismeretlen partner)'}</span>
          <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, overflowWrap: 'anywhere' }}>
            {shortDate(t.date)} · {acc?.bank_name}
            {t.memo ? ' · ' + t.memo : ''}
          </span>
        </div>
        <span style={{ font: `700 17px ${FONT_H}`, color: t.amount > 0 ? C.blueDark : C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {t.amount > 0 ? '+' : '−'}
          {fmt(Math.abs(t.amount))}
        </span>
      </div>

      {canEdit && (
        <>
          <div style={row}>
            <span style={label}>Megnevezés</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mi volt ez?"
              style={{ ...inputStyle, flex: 1, minWidth: 200, height: 36 }}
            />
          </div>

          <div style={row}>
            <span style={label}>Kategória</span>
            <div style={chips}>
              {leafChips.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  title={displayGroup(ix.groupById[l.group_id]?.label || '')}
                  onClick={() => pickLeaf(l.id)}
                  style={chip(leaf === l.id)}
                >
                  {leaf === l.id ? '✓ ' : ''}
                  {l.label}
                </button>
              ))}
              <input
                value={catQ}
                onChange={(e) => {
                  setCatQ(e.target.value);
                  setNewGroupFor(null);
                }}
                placeholder="🔍 keresés vagy új…"
                style={{ ...inputStyle, height: 32, width: 170, borderRadius: 999, fontSize: 12.5 }}
              />
              {q && !exact && (
                <button type="button" onClick={() => setNewGroupFor(catQ.trim())} style={{ ...chip(false), borderStyle: 'dashed', color: C.blueDark }}>
                  + Új: „{catQ.trim()}”
                </button>
              )}
            </div>
          </div>
          {newGroupFor && (
            <div style={{ ...row, background: C.bg2, borderRadius: 10, padding: '8px 10px' }}>
              <span style={{ ...label, paddingTop: mobile ? 0 : 6 }}>Melyik csoport?</span>
              <div style={chips}>
                {ix.groups
                  .filter((g) => g.section === section)
                  .map((g) => (
                    <button key={g.id} type="button" onClick={() => createLeaf(g.id)} style={chip(false)}>
                      {displayGroup(g.label)}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div style={row}>
            <span style={label}>Terv</span>
            <div style={chips}>
              <button type="button" onClick={() => setPlan(null)} style={chip(!plan, C.navy)}>
                {!plan ? '✓ ' : ''}Nincs terv – új tény
              </button>
              {planChips.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    setPlan(e.id);
                    setLeaf(e.leaf_id);
                  }}
                  style={chip(plan === e.id)}
                  title={ix.leafById[e.leaf_id]?.label}
                >
                  {plan === e.id ? '✓ ' : ''}
                  {(e.name || ix.leafById[e.leaf_id]?.label || '').slice(0, 34)} · {monthLabel(ymOf(e.date))} {Number(e.date.slice(8))}. ·{' '}
                  {fmt(Math.abs(e.amount))}
                </button>
              ))}
              <input
                value={planQ}
                onChange={(e) => setPlanQ(e.target.value)}
                placeholder="🔍 terv keresése…"
                style={{ ...inputStyle, height: 32, width: 160, borderRadius: 999, fontSize: 12.5 }}
              />
            </div>
          </div>

          <div style={row}>
            <span style={label}>Ismétlődik?</span>
            <div style={chips}>
              {(
                [
                  ['once', 'Egyszeri'],
                  ['monthly', 'Havonta'],
                  ['quarterly', 'Negyedévente'],
                ] as [Rep, string][]
              ).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setRep(v)} style={chip(rep === v, C.navy)}>
                  {l}
                </button>
              ))}
              {rep !== 'once' && (
                <>
                  <span style={{ width: 1, height: 22, background: C.line2, margin: '0 4px' }} />
                  {[6, 12, 24].map((c) => (
                    <button key={c} type="button" onClick={() => setCount(c)} style={chip(count === c, C.navy)}>
                      {c} hó
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 12 }}>
            <span style={{ flex: '1 1 260px', font: `500 12.5px/1.45 ${FONT}`, color: C.muted }}>
              Tény: <b style={{ color: C.navy }}>{t.date.replace(/-/g, '.')}.</b> (banki dátum)
              {leaf ? ` → ${ix.leafById[leaf]?.label}` : ''}
              {planE ? ` · lezárja: ${planE.name || 'terv'}` : ''}
              {n ? ` · + ${n} terv: ${nextDates.map((d) => `${monthLabel(ymOf(d))} ${Number(d.slice(8))}.`).join(', ')}${n > 3 ? ' …' : ''}` : ''}
              {planE && diff !== 0 && (
                <span style={{ display: 'block', color: '#8A6D1C' }}>
                  Eltérés a tervtől: {diff > 0 ? '+' : '−'}
                  {fmt(Math.abs(diff))} Ft
                </span>
              )}
              {dup && (
                <span style={{ display: 'block', color: C.neg }}>
                  Lehetséges duplikáció: már van ilyen tény ({dup.date}, {dup.name}) – ha az, hagyd ki.
                </span>
              )}
            </span>
            <Pill
              small
              onClick={() =>
                run(
                  () => api('/api/bank/ignore', { body: { ids: [t.id] } }),
                  'Tétel kihagyva',
                  () => api('/api/bank/ignore', { body: { ids: [t.id], undo: true } }),
                )
              }
            >
              Kihagy
            </Pill>
            <Pill kind="dark" disabled={!leaf} onClick={approve} style={mobile ? { flex: 1 } : undefined}>
              Jóváhagy ✓
            </Pill>
          </div>
        </>
      )}
    </div>
  );
}
