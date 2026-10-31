// Egy beérkezett banki tétel jóváhagyó kártyája: megnevezés, kategória, terv-párosítás, ismétlődés – legördülő és felugró ablak nélkül.
import { useMemo, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { fmt, monthLabel, ymOf } from '../../shared/model';
import type { BankTx, Entry, Rep } from '../../shared/types';
import { api } from './api';
import { repStep, shiftDate } from './logic';
import { PartnerLink } from './PartnerCard';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, card, inputStyle, shortDate, R } from './ui';

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
/** az asztali tábla oszlopai (fejléc és sorok közösen) */
export const BANK_COLS = '58px 66px minmax(160px,1.5fr) minmax(130px,1fr) minmax(120px,1fr) 92px 104px 184px';
/** a tábla legkisebb szélessége: ennél keskenyebb ablakban vízszintesen görget, nem csúszik egymásba */
export const BANK_MINW = 1000;
const chips: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: 1, minWidth: 0 };

export function TxCard({
  t,
  frequent,
  unforeseen,
  mobile,
  open,
  onToggle,
  actions,
}: {
  t: BankTx;
  frequent: string[];
  unforeseen: string | null;
  mobile?: boolean;
  /** asztali táblasor: lenyitva látszik a teljes szerkesztő */
  open?: boolean;
  onToggle?: () => void;
  /** a lenyitott sor műveletei a billentyűkhöz (Enter = jóváhagy, K = kihagy) */
  actions?: { current: { approve: () => void; skip: () => void } | null };
}) {
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
    setOpenG(ix.leafById[id]?.group_id || null);
    const p = plan ? data.entries.find((e) => e.id === plan) : null;
    if (p && p.leaf_id !== id) setPlan(null);
  };
  const [name, setName] = useState(t.partner || t.memo || '');
  const [rep, setRep] = useState<Rep>('once');
  const [count, setCount] = useState(12);
  const [catQ, setCatQ] = useState('');
  const [planQ, setPlanQ] = useState('');
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null);
  // mappa-fa: a kiválasztott kategória mappája nyitva
  const [openG, setOpenG] = useState<string | null>(() => (leaf ? ix.leafById[leaf]?.group_id || null : null));
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
          // hónap-távolság a tranzakció hónapjától: elöl a tranzakció hónapjának tervei, utána a szomszédos hónapoké
          dm: Math.abs((Number(e.date.slice(0, 4)) - Number(t.date.slice(0, 4))) * 12 + Number(e.date.slice(5, 7)) - Number(t.date.slice(5, 7))),
        }))
        .filter((x) => x.dd <= 60)
        .sort(
          (a, b) =>
            Number(b.e.id === plan) - Number(a.e.id === plan) ||
            a.dm - b.dm ||
            Number(b.e.leaf_id === leaf) - Number(a.e.leaf_id === leaf) ||
            a.da - b.da ||
            a.dd - b.dd,
        )
        .slice(0, 5)
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

  const skip = () =>
    run(
      () => api('/api/bank/ignore', { body: { ids: [t.id] } }),
      'Tétel kihagyva',
      () => api('/api/bank/ignore', { body: { ids: [t.id], undo: true } }),
    );
  if (open && actions) actions.current = { approve, skip };

  if (!mobile) {
    // asztali táblasor (látványterv): összefoglaló sor, lenyitva a szerkesztő két oszlopban
    const L = leaf ? ix.leafById[leaf] : null;
    const repLabel = { once: 'Egyszeri', monthly: 'Havonta', quarterly: 'Negyedévente', yearly: 'Évente' }[rep as string] || 'Egyszeri';
    const groupsSec = ix.groups.filter((g) => g.section === section);
    const curG = openG || L?.group_id || groupsSec[0]?.id || null;
    const sub: React.CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted };
    return (
      <div style={{ borderTop: `1px solid ${C.line}`, borderLeft: `3px solid ${open ? C.blue : 'transparent'}`, background: '#fff', minWidth: BANK_MINW }}>
        <div
          onClick={onToggle}
          role="button"
          tabIndex={0}
          aria-expanded={!!open}
          aria-label={`${name || t.partner || 'banki tétel'}, ${fmt(Math.abs(t.amount))} Ft – részletek`}
          onKeyDown={(ev) => ev.target === ev.currentTarget && (ev.key === ' ' || ev.key === 'Enter') && (ev.preventDefault(), onToggle?.())}
          style={{ display: 'grid', gridTemplateColumns: BANK_COLS, gap: 12, alignItems: 'center', padding: '14px 18px', cursor: 'pointer' }}
        >
          <b style={{ font: `600 14.5px ${FONT}`, color: C.navy }}>{t.date.slice(5).replace('-', '.')}.</b>
          <span>
            <span style={{ padding: '3px 9px', borderRadius: R.md, background: C.bg, font: `500 12px ${FONT}`, color: C.muted }}>{acc?.bank_name || '—'}</span>
          </span>
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <b style={{ font: `600 15px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name || t.partner || '(ismeretlen partner)'}
            </b>
            <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[acc?.bank_name, t.memo].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            {L ? (
              <>
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: C.bg2,
                    color: C.blueDark,
                    font: `600 13px ${FONT}`,
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  ✓ {L.label}
                </span>
                <span style={{ font: `400 11.5px ${FONT}`, color: C.faint }}>{displayGroup(ix.groupById[L.group_id]?.label || '')}</span>
              </>
            ) : (
              <span style={{ font: `500 13px ${FONT}`, color: C.neg }}>nincs kategória</span>
            )}
          </span>
          <span style={{ font: `400 13.5px ${FONT}`, color: planE ? C.navy : C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {planE ? planE.name || 'terv' : 'Nincs terv – új tény'}
          </span>
          <span style={{ font: `400 13.5px ${FONT}`, color: C.ink }}>{repLabel}</span>
          <b
            style={{
              font: `700 17px ${FONT_H}`,
              color: t.amount > 0 ? C.inc : C.navy,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
              whiteSpace: 'nowrap',
            }}
          >
            {t.amount > 0 ? '+' : '−'}
            {fmt(Math.abs(t.amount))}
          </b>
          {canEdit ? (
            <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
              <Pill small onClick={skip}>
                Kihagy
              </Pill>
              <Pill small kind="dark" disabled={!leaf} onClick={approve}>
                Jóváhagy ✓
              </Pill>
            </span>
          ) : (
            <span />
          )}
        </div>

        {open && canEdit && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: 24, padding: '0 18px 18px clamp(18px, 12vw, 230px)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <span style={sub}>Megnevezés</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mi volt ez?"
                style={{ ...inputStyle, height: 42, font: `500 15px ${FONT}` }}
              />
              <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, overflowWrap: 'anywhere' }}>
                Teljes közlemény: {[acc?.bank_name, t.partner, t.memo].filter(Boolean).join(' · ')}
              </span>
              <span style={{ ...sub, marginTop: 6 }}>Kategória</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
              {newGroupFor && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', background: C.bg2, borderRadius: R.lg, padding: '8px 10px' }}>
                  <span style={{ font: `600 12px ${FONT}`, color: C.muted }}>Melyik csoport?</span>
                  {groupsSec.map((g) => (
                    <button key={g.id} type="button" onClick={() => createLeaf(g.id)} style={chip(false)}>
                      {displayGroup(g.label)}
                    </button>
                  ))}
                </div>
              )}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(180px,.8fr) minmax(0,1.6fr)',
                  border: `1px solid ${C.line}`,
                  borderRadius: R.lg,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    borderRight: `1px solid ${C.line}`,
                    padding: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    maxHeight: 260,
                    overflowY: 'auto',
                  }}
                >
                  {groupsSec.map((g) => {
                    const cnt = sectionLeaves.filter((l) => l.group_id === g.id).length;
                    const on = curG === g.id;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setOpenG(g.id)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 8,
                          border: 0,
                          borderRadius: R.md,
                          padding: '7px 10px',
                          background: on ? C.bg : 'transparent',
                          font: `${on ? 700 : 500} 13.5px ${FONT}`,
                          color: C.navy,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span>{displayGroup(g.label)}</span>
                        <span style={{ font: `500 11.5px ${FONT}`, color: C.faint }}>{cnt}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ padding: 10, display: 'flex', gap: 7, flexWrap: 'wrap', alignContent: 'flex-start', maxHeight: 260, overflowY: 'auto' }}>
                  {sectionLeaves
                    .filter((l) => l.group_id === curG)
                    .sort((a, b) => a.label.localeCompare(b.label, 'hu'))
                    .map((l) => (
                      <button key={l.id} type="button" onClick={() => pickLeaf(l.id)} style={chip(leaf === l.id)}>
                        {leaf === l.id ? '✓ ' : ''}
                        {l.label}
                      </button>
                    ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ ...sub, flex: 1 }}>Terv · melyik tervet teljesíti?</span>
                <input
                  value={planQ}
                  onChange={(e) => setPlanQ(e.target.value)}
                  placeholder="🔍 terv keresése…"
                  style={{ border: 0, outline: 'none', font: `500 13px ${FONT}`, color: C.ink, width: 150, background: 'transparent' }}
                />
              </div>
              <div style={{ border: `1px solid ${C.line}`, borderRadius: R.lg, overflow: 'hidden' }}>
                {[null, ...planChips].map((e, i) => {
                  const on = e ? plan === e.id : !plan;
                  const d = e ? Math.abs(t.amount) - Math.abs(e.amount) : 0;
                  return (
                    <button
                      key={e?.id || 'none'}
                      type="button"
                      onClick={() => {
                        if (!e) return setPlan(null);
                        setPlan(e.id);
                        setLeaf(e.leaf_id);
                        setOpenG(ix.leafById[e.leaf_id]?.group_id || null);
                      }}
                      style={{
                        width: '100%',
                        display: 'grid',
                        gridTemplateColumns: e ? '18px minmax(110px,1fr) 58px 78px 70px' : '18px 1fr',
                        gap: 10,
                        alignItems: 'center',
                        border: 0,
                        borderTop: i ? `1px solid ${C.line3}` : 0,
                        background: on ? C.bg2 : '#fff',
                        padding: '10px 12px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 999,
                          border: `${on ? 4.5 : 1.5}px solid ${on ? C.blue : C.line2}`,
                          boxSizing: 'border-box',
                          background: '#fff',
                        }}
                      />
                      <span
                        style={{ font: `${on ? 600 : 500} 14px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={e ? ix.leafById[e.leaf_id]?.label : undefined}
                      >
                        {e ? e.name || ix.leafById[e.leaf_id]?.label : 'Nincs terv – új tény'}
                      </span>
                      {e && (
                        <>
                          <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>
                            {monthLabel(ymOf(e.date))} {Number(e.date.slice(8))}.
                          </span>
                          <span style={{ font: `500 13.5px ${FONT}`, color: C.ink, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(Math.abs(e.amount))}
                          </span>
                          <span
                            style={{
                              font: `500 12.5px ${FONT}`,
                              color: Math.abs(d) < Math.abs(t.amount) * 0.05 ? C.blueDark : C.faint,
                              textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {d > 0 ? '+' : d < 0 ? '−' : '±'}
                            {fmt(Math.abs(d))}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              {!pq && !planChips.some((e) => ymOf(e.date) === ymOf(t.date)) && (
                <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                  {monthLabel(ymOf(t.date))}-ban/-ben nincs nyitott terv – a szomszédos hónapok tervei látszanak
                </span>
              )}
              <span style={{ ...sub, marginTop: 6 }}>Ismétlődik?</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3, gap: 2 }}>
                  {(
                    [
                      ['once', 'Egyszeri'],
                      ['monthly', 'Havonta'],
                      ['quarterly', 'Negyedévente'],
                      ['yearly', 'Évente'],
                    ] as [Rep, string][]
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        setRep(v);
                        if (v === 'yearly') setCount(36);
                      }}
                      style={{
                        border: 0,
                        borderRadius: 999,
                        padding: '7px 16px',
                        font: `600 13.5px ${FONT}`,
                        cursor: 'pointer',
                        background: rep === v ? C.navy : 'transparent',
                        color: rep === v ? '#fff' : C.muted,
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                {rep !== 'once' &&
                  (rep === 'yearly' ? [12, 24, 36] : [6, 12, 24]).map((c) => (
                    <button key={c} type="button" onClick={() => setCount(c)} style={chip(count === c, C.navy)}>
                      {rep === 'yearly' ? `${c / 12} év` : `${c} hó`}
                    </button>
                  ))}
              </div>
              <div style={{ marginTop: 6, background: C.bg3, borderRadius: R.lg, padding: '12px 14px', font: `500 13.5px/1.5 ${FONT}`, color: C.ink }}>
                Tény: <b style={{ color: C.navy }}>{t.date.replace(/-/g, '.')}.</b> (banki dátum)
                {L ? (
                  <>
                    {' → '}
                    <b>
                      <PartnerLink leaf={L.id}>{L.label}</PartnerLink>
                    </b>
                  </>
                ) : null}
                {planE ? ` · lezárja: ${planE.name || 'terv'}` : ''}
                {n
                  ? ` · + ${n} terv: ${nextDates.map((d) => (rep === 'yearly' ? d.replace(/-/g, '.') + '.' : `${monthLabel(ymOf(d))} ${Number(d.slice(8))}.`)).join(', ')}${n > 3 ? ' …' : ''}`
                  : ''}
                {planE && diff !== 0 && (
                  <span style={{ display: 'block', color: C.offer }}>
                    Eltérés a tervtől: {diff > 0 ? '+' : '−'}
                    {fmt(Math.abs(diff))} Ft
                  </span>
                )}
                {dup && (
                  <span style={{ display: 'block', color: C.neg }}>
                    Lehetséges duplikáció: már van ilyen tény ({dup.date}, {dup.name}) – ha az, hagyd ki.
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

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
        <span style={{ font: `700 17px ${FONT_H}`, color: t.amount > 0 ? C.inc : C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
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
            <div style={{ ...row, background: C.bg2, borderRadius: R.lg, padding: '8px 10px' }}>
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
            <span style={label}>Mappa</span>
            <div
              style={{ flex: 1, minWidth: 0, border: `1px solid ${C.line2}`, borderRadius: R.lg, padding: 6, display: 'flex', flexDirection: 'column', gap: 1 }}
            >
              {ix.groups
                .filter((g) => g.section === section)
                .map((g) => {
                  const members = sectionLeaves.filter((l) => l.group_id === g.id).sort((a, b) => a.label.localeCompare(b.label, 'hu'));
                  const on = !!leaf && ix.leafById[leaf]?.group_id === g.id;
                  const expanded = openG === g.id;
                  return (
                    <div key={g.id}>
                      <button
                        type="button"
                        onClick={() => setOpenG(expanded ? null : g.id)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          border: 0,
                          borderRadius: R.md,
                          padding: '5px 8px',
                          background: on ? C.bg3 : 'transparent',
                          font: `${on ? 700 : 500} 13px ${FONT}`,
                          color: on ? C.navy : C.ink,
                          cursor: 'pointer',
                          display: 'flex',
                          gap: 6,
                        }}
                      >
                        <span style={{ width: 12, color: C.muted }}>{expanded ? '▾' : '▸'}</span>
                        <span>{on ? '📂' : '📁'}</span>
                        <span style={{ flex: 1 }}>
                          {displayGroup(g.label)}
                          {on && !expanded ? <span style={{ color: C.blueDark }}> › ✓ {ix.leafById[leaf!]?.label}</span> : ''}
                        </span>
                        <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>{members.length}</span>
                      </button>
                      {expanded && (
                        <div style={{ padding: '4px 0 8px 30px', display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 220, overflowY: 'auto' }}>
                          {members.map((l) => (
                            <button key={l.id} type="button" onClick={() => pickLeaf(l.id)} style={chip(leaf === l.id)}>
                              {leaf === l.id ? '✓ ' : ''}
                              {l.label}
                            </button>
                          ))}
                          {!members.length && <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>üres mappa</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>

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
                    setOpenG(ix.leafById[e.leaf_id]?.group_id || null);
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
              {!pq && !planChips.some((e) => ymOf(e.date) === ymOf(t.date)) && (
                <span style={{ alignSelf: 'center', font: `500 12px ${FONT}`, color: C.muted }}>
                  {monthLabel(ymOf(t.date))}-ban/-ben nincs nyitott terv – a szomszédos hónapok tervei látszanak
                </span>
              )}
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
                  ['yearly', 'Évente'],
                ] as [Rep, string][]
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setRep(v);
                    if (v === 'yearly') setCount(36);
                  }}
                  style={chip(rep === v, C.navy)}
                >
                  {l}
                </button>
              ))}
              {rep !== 'once' && (
                <>
                  <span style={{ width: 1, height: 22, background: C.line2, margin: '0 4px' }} />
                  {(rep === 'yearly' ? [12, 24, 36] : [6, 12, 24]).map((c) => (
                    <button key={c} type="button" onClick={() => setCount(c)} style={chip(count === c, C.navy)}>
                      {rep === 'yearly' ? `${c / 12} év` : `${c} hó`}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 12 }}>
            <span style={{ flex: '1 1 260px', font: `500 12.5px/1.45 ${FONT}`, color: C.muted }}>
              Tény: <b style={{ color: C.navy }}>{t.date.replace(/-/g, '.')}.</b> (banki dátum)
              {leaf ? (
                <>
                  {' → '}
                  <PartnerLink leaf={leaf}>{ix.leafById[leaf]?.label}</PartnerLink>
                </>
              ) : (
                ''
              )}
              {planE ? ` · lezárja: ${planE.name || 'terv'}` : ''}
              {n
                ? ` · + ${n} terv: ${nextDates.map((d) => (rep === 'yearly' ? d.replace(/-/g, '.') + '.' : `${monthLabel(ymOf(d))} ${Number(d.slice(8))}.`)).join(', ')}${n > 3 ? ' …' : ''}`
                : ''}
              {planE && diff !== 0 && (
                <span style={{ display: 'block', color: C.offer }}>
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
            <Pill small onClick={skip}>
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
