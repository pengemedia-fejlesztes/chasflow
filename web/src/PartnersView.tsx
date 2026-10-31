// Partnerek: egy partner = a Cash-ben használt név (bevételi és kiadási oldalon is). Az adatlapon a számlázási
// (cég)nevek, a múltbeli tények, a várható tételek, az összetevők, a Billingo számlák és a fizetési fegyelem látszik.
import { useMemo, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { addMonths, fmt, fmtM } from '../../shared/model';
import { partnerStats, type Component, type PartnerStat } from '../../shared/partners';
import type { Entry, Section } from '../../shared/types';
import { api } from './api';
import { useBack } from './back';
import { DivergingBars } from './Bars';
import { diffColor, diffText } from './LinkChain';
import { PartnerLink } from './PartnerCard';
import { rowKey } from './logic';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, Seg, card, inputStyle, R } from './ui';

const dd = (d: string | null | undefined) => (d ? d.replace(/-/g, '.') + '.' : '–');
const pct = (v: number) => `${Math.round(v * 100)}%`;
type Side = 'in' | 'out' | 'all';

export function usePartners() {
  const { data, ix } = useStore();
  return useMemo(
    () => partnerStats(data.entries, ix.leaves, ix.groups, data.billingo, data.today, data.partnerNames || [], data.partners || []),
    [data.entries, data.billingo, data.today, data.partnerNames, data.partners, ix],
  );
}

function trend(p: PartnerStat, sec: Section) {
  const s = p.sides[sec];
  if (!s) return null;
  if (!s.prev12) return s.last12 ? { t: 'új', bad: false } : null;
  const ch = (s.last12 - s.prev12) / s.prev12;
  return { t: `${ch > 0 ? '+' : ''}${Math.round(ch * 100)}%`, bad: sec === 'in' ? ch < -0.05 : ch > 0.05 };
}

export function PartnersView({ mobile, initialKey, onBack }: { mobile?: boolean; initialKey?: string | null; onBack?: () => void }) {
  const stats = usePartners();
  const { openPartner } = useStore();
  const [sel, setSel] = useState<string | null>(initialKey || null);
  const [side, setSide] = useState<Side>('in');
  const [sort, setSort] = useState<'last12' | 'total'>('last12');
  const [q, setQ] = useState('');
  const cur = sel ? stats.find((p) => p.key === sel) : null;
  useBack(!!cur, () => (initialKey && onBack ? onBack() : setSel(null)));
  if (cur) return <PartnerDetail p={cur} mobile={mobile} onBack={() => (initialKey && onBack ? onBack() : setSel(null))} />;

  const nq = normalizeText(q);
  const val = (p: PartnerStat) => {
    const f = (s: Section) => p.sides[s]?.[sort] || 0;
    return side === 'all' ? f('in') + f('out') : f(side);
  };
  const list = stats
    .filter((p) => (side === 'all' ? true : !!p.sides[side]))
    .filter((p) => !nq || normalizeText(p.name + ' ' + p.billingNames.map((b) => b.name).join(' ')).includes(nq))
    .sort((a, b) => val(b) - val(a));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg
          value={side}
          onChange={setSide}
          options={[
            ['in', 'Bevétel'],
            ['out', 'Kiadás'],
            ['all', 'Mind'],
          ]}
        />
        <Seg
          small
          value={sort}
          onChange={setSort}
          options={[
            ['last12', 'Utolsó 12 hó'],
            ['total', 'Összesen'],
          ]}
        />
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Partner vagy cégnév keresése…" style={{ ...inputStyle, height: 44 }} />
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>{list.length} partner</span>
      {list.map((p) => {
        const secs = (side === 'all' ? ['in', 'out'] : [side]) as Section[];
        return (
          <button
            key={p.key}
            onClick={() => openPartner(p.key)}
            style={{
              ...card,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              textAlign: 'left',
              cursor: 'pointer',
              borderColor: p.outstanding ? C.negLight : C.line,
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
              <b style={{ font: `700 15px ${FONT}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</b>
              <span style={{ font: `500 12px ${FONT}`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.billingNames[0]?.name || p.groups.map((g) => displayGroup(g.label)).join(', ')} · utolsó: {dd(p.last)}
              </span>
            </span>
            {secs.map((s) => {
              const st = p.sides[s];
              if (!st) return null;
              const tr = trend(p, s);
              return (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                  <span style={{ font: `600 11.5px ${FONT}`, color: C.muted, width: 52 }}>{s === 'in' ? 'Bevétel' : 'Kiadás'}</span>
                  <div style={{ flex: 1, height: 6, borderRadius: 999, background: C.line3, overflow: 'hidden' }}>
                    <div style={{ width: pct(Math.min(1, st.share12)), height: '100%', borderRadius: 999, background: s === 'in' ? C.blue : C.muted2 }} />
                  </div>
                  <b style={{ font: `700 14px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums', minWidth: 86, textAlign: 'right' }}>
                    {fmt(st[sort])}
                  </b>
                  <span style={{ font: `600 11px ${FONT}`, color: tr?.bad ? C.neg : C.muted, minWidth: 40, textAlign: 'right' }}>
                    {sort === 'last12' ? tr?.t || '' : ''}
                  </span>
                </div>
              );
            })}
            {p.outstanding > 0 && <span style={{ font: `600 12px ${FONT}`, color: C.neg }}>Lejárt kintlévőség: {fmt(p.outstanding)} Ft</span>}
          </button>
        );
      })}
    </div>
  );
}

function Tile({ label, value, sub, red }: { label: string; value: string; sub?: string; red?: boolean }) {
  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${C.line}`,
        borderRadius: R.lg,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      }}
    >
      <span style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted }}>{label}</span>
      <b
        style={{
          font: `700 17px ${FONT_H}`,
          color: red ? C.neg : C.navy,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </b>
      {sub && <span style={{ font: `500 11.5px ${FONT}`, color: red ? C.neg : C.muted }}>{sub}</span>}
    </div>
  );
}

/**
 * Számlázási nevek (cégadat): a partnerhez tartozó összes név egy helyen – Billingo (kimenő számla), NAV (bejövő számla,
 * adószámmal), bank (utaló / kedvezményezett), alternatív név. Bármelyik név hozzárendelhető: alternatív névként kerül
 * a partnerhez, így a program a banki, NAV- és Billingo-tételeket ezen a néven is ehhez a partnerhez párosítja.
 */
function NamesBox({ p }: { p: PartnerStat }) {
  const { data, run, canEdit } = useStore();
  const [q, setQ] = useState('');
  const aliases = p.info?.aliases || [];
  const own = useMemo(() => new Set([p.name, ...aliases].map(normalizeText)), [p.name, aliases]);
  type Row = { name: string; src: Record<string, number>; tax?: string };
  const rows = useMemo(() => {
    const ids = new Set(p.leaves.map((l) => l.id));
    const ents = new Set(data.entries.filter((e) => ids.has(e.leaf_id)).map((e) => e.id));
    const m = new Map<string, Row>();
    const add = (name: string | null | undefined, src: string, n = 1, tax?: string | null) => {
      const t = String(name || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t.length < 2) return;
      const k = normalizeText(t);
      const r = m.get(k) || { name: t, src: {} };
      r.src[src] = (r.src[src] || 0) + n;
      if (tax) r.tax = tax;
      m.set(k, r);
    };
    for (const b of p.billingNames) add(b.name, b.source === 'Billingo' ? 'Billingo' : 'Bank', b.n);
    for (const x of data.navInvoices || [])
      if ((x.leaf_id && ids.has(x.leaf_id)) || (x.plan_id && ents.has(x.plan_id)) || (x.actual_id && ents.has(x.actual_id)))
        add(x.partner_name, 'NAV', 1, x.partner_tax);
    for (const a of aliases) add(a, 'alias', 0);
    return [...m.values()].sort((a, b) => sumOf(b) - sumOf(a));
  }, [p, data.entries, data.navInvoices, aliases]);
  // hozzárendelhető nevek: a Billingo-, NAV- és banki nevek közül, amik még egyik partnerhez sincsenek rendelve ennél a partnernél
  const known = useMemo(() => {
    const seen = new Set(rows.map((r) => normalizeText(r.name)));
    const out: { name: string; src: string }[] = [];
    const add = (s: string | null | undefined, src: string) => {
      const t = String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
      const k = normalizeText(t);
      if (k.length < 2 || seen.has(k)) return;
      seen.add(k);
      out.push({ name: t, src });
    };
    data.billingo.forEach((d) => add(d.partner, 'Billingo'));
    (data.navInvoices || []).forEach((n) => add(n.partner_name, 'NAV'));
    data.bankTx.forEach((t) => add(t.partner, 'Bank'));
    return out;
  }, [rows, data.billingo, data.navInvoices, data.bankTx]);
  const words = (s: string) =>
    normalizeText(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !/^(kft|zrt|bt|nyrt|korlatolt|felelossegu|tarsasag|szolgaltato|es)$/.test(w));
  const mine = new Set([p.name, ...aliases].flatMap(words));
  const nq = normalizeText(q);
  const list = nq
    ? known.filter((k) => normalizeText(k.name).includes(nq)).slice(0, 12)
    : known.filter((k) => words(k.name).some((w) => mine.has(w))).slice(0, 8);
  const assign = (name: string) =>
    run(
      () =>
        api(`/api/partners/${encodeURIComponent(p.key)}`, {
          method: 'PUT',
          body: { name: p.name, kind: p.info?.kind ?? null, aliases: [...aliases, name], tax_number: p.info?.tax_number || '', note: p.info?.note || '' },
        }),
      `„${name}” hozzárendelve: ${p.name}`,
    ).then(() => setQ(''));
  const badge = (label: string, bg: string, fg: string) => (
    <span key={label} style={{ font: `600 11px ${FONT}`, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
  return (
    <Box title="Számlázási nevek (cégadat)">
      {rows.length ? (
        rows.map((r) => (
          <div key={r.name} style={{ display: 'flex', gap: 8, padding: '6px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 200px', font: `600 13.5px ${FONT}`, color: C.ink }}>
              {r.name}
              {r.tax ? <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}> · {r.tax}</span> : null}
            </span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {r.src.Billingo ? badge(`Billingo · kimenő számla ${r.src.Billingo}×`, '#E6F0FA', C.blueDark) : null}
              {r.src.NAV ? badge(`NAV · bejövő számla ${r.src.NAV}×`, '#F3EDFB', '#5B3E8C') : null}
              {r.src.Bank ? badge(`Bank ${r.src.Bank}×`, C.incBg, '#23714A') : null}
              {own.has(normalizeText(r.name)) ? badge('✓ párosít', C.bg2, C.navy) : null}
            </span>
            {canEdit && !own.has(normalizeText(r.name)) && (
              <button
                type="button"
                onClick={() => assign(r.name)}
                title="Alternatív névként rögzíti – a jövőbeli tételek is ehhez a partnerhez kerülnek"
                style={{
                  border: `1px solid ${C.line2}`,
                  background: '#fff',
                  borderRadius: 999,
                  padding: '3px 10px',
                  font: `600 12px ${FONT}`,
                  color: C.blueDark,
                  cursor: 'pointer',
                }}
              >
                ＋ rögzít
              </button>
            )}
          </div>
        ))
      ) : (
        <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
          Még nincs Billingo-számla, NAV-számla vagy jóváhagyott banki tétel ezzel a partnerrel.
        </span>
      )}
      {canEdit && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: `1px solid ${C.line3}`, marginTop: 4 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="＋ Név hozzárendelése – keresés a Billingo-, NAV- és banki nevek között…"
            style={{ ...inputStyle, height: 34, fontSize: 13 }}
          />
          {list.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {!nq && <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>Lehet, hogy ez is ő:</span>}
              {list.map((k) => (
                <button
                  key={k.name}
                  type="button"
                  onClick={() => assign(k.name)}
                  style={{
                    border: `1px dashed ${C.blue}`,
                    background: '#fff',
                    borderRadius: 999,
                    padding: '4px 10px',
                    font: `600 12px ${FONT}`,
                    color: C.blueDark,
                    cursor: 'pointer',
                  }}
                >
                  ＋ {k.name} <span style={{ opacity: 0.6, fontWeight: 500 }}>· {k.src}</span>
                </button>
              ))}
            </div>
          )}
          {nq && !list.length && <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>Nincs ilyen név a számlák és a bank között.</span>}
        </div>
      )}
    </Box>
  );
}
const sumOf = (r: { src: Record<string, number> }) => Object.values(r.src).reduce((a, b) => a + b, 0);

function Box({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, paddingBottom: 4 }}>
        <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>{title}</b>
        {right}
      </div>
      {children}
    </div>
  );
}

function ItemRow({ e, sec, future, onEdit, plan }: { e: Entry; sec: Section; future?: boolean; onEdit?: () => void; plan?: Entry }) {
  const diff = plan ? Math.abs(e.amount) - Math.abs(plan.amount) : 0;
  const { data, canEdit } = useStore();
  const late = future && !e.tentative && e.date < data.today;
  const click = canEdit && onEdit;
  return (
    <div
      onClick={click ? onEdit : undefined}
      title={click ? 'Tétel szerkesztése' : undefined}
      className={click ? 'hov-light' : undefined}
      style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline', cursor: click ? 'pointer' : 'default' }}
    >
      <span style={{ font: `500 12.5px ${FONT}`, color: late ? C.neg : C.muted, width: 84, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
        {dd(e.date)}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ font: `500 13.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name || '–'}</span>
        <span style={{ font: `500 11px ${FONT}`, color: late ? C.neg : C.muted }}>
          {sec === 'in' ? 'bevétel' : 'kiadás'}
          {future ? (e.tentative ? ' · ajánlat' : late ? ' · lejárt terv' : ' · terv') : ''}
          {plan && (
            <>
              {' · terv '}
              {fmt(Math.abs(plan.amount))}
              {diff ? <b style={{ color: diffColor(sec, diff) }}> · eltérés {diffText(diff)}</b> : ' · pontosan a terv'}
            </>
          )}
        </span>
      </span>
      {/* előjel a pénzmozgás iránya szerint: a jóváíró (mínuszos) számla a bevételi oldalon is mínusz */}
      <b
        style={{
          font: `700 13.5px ${FONT}`,
          color: e.amount < 0 && sec === 'in' ? C.neg : sec === 'in' ? C.navy : C.muted,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {e.amount < 0 ? '−' : '+'}
        {fmt(Math.abs(e.amount))}
      </b>
      {click && <span style={{ font: `600 12px ${FONT}`, color: C.blueDark }}>{future ? 'Szerkesztés ›' : 'Részletek ›'}</span>}
    </div>
  );
}

function Comps({ list }: { list: Component[] }) {
  const tot = list.reduce((s, c) => s + Math.abs(c.total), 0) || 1;
  return (
    <>
      {list.slice(0, 8).map((c) => (
        <div key={c.section + c.name} style={{ padding: '6px 0', borderTop: `1px solid ${C.line3}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ flex: 1, minWidth: 0, font: `500 13px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.name}{' '}
              <span style={{ color: C.muted, fontSize: 11.5 }}>
                · {c.section === 'in' ? 'bevétel' : 'kiadás'} · {c.count} db
              </span>
            </span>
            <b style={{ font: `700 13px ${FONT}`, color: c.total < 0 ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums' }}>
              {c.total < 0 ? '−' : ''}
              {fmt(Math.abs(c.total))}
            </b>
          </div>
          <div style={{ height: 4, borderRadius: 999, background: C.line3 }}>
            <div style={{ width: pct(Math.abs(c.total) / tot), height: '100%', borderRadius: 999, background: c.section === 'in' ? C.blue : C.muted2 }} />
          </div>
        </div>
      ))}
    </>
  );
}

export function PartnerDetail({
  p,
  mobile,
  onBack,
  embedded,
  onEditItem,
  part = 'all',
}: {
  p: PartnerStat;
  mobile?: boolean;
  onBack: () => void;
  embedded?: boolean;
  /** names = csak a számlázási nevek (adatlap Cégadatok fül), stats = a számlázási nevek nélkül */
  part?: 'all' | 'names' | 'stats';
  /** a várható tétel szerkesztése (partner adatlapon) */
  onEditItem?: (leaf: string, key: string) => void;
}) {
  const { ix, data } = useStore();
  const [all, setAll] = useState(false);
  // tény → a hozzá kötött terv (a terv összege nem változik, így az eltérés látszik)
  const planOfActual = useMemo(() => {
    const ids = new Set(p.leaves.map((l) => l.id));
    const m = new Map<string, Entry>();
    for (const e of data.entries) if (e.kind === 'plan' && e.done && e.link_id && ids.has(e.leaf_id)) m.set(e.link_id, e);
    return m;
  }, [p.leaves, data.entries]);
  const diff12 = useMemo(() => {
    const from = addMonths(ix.cur, -12) + '-01';
    let sum = 0,
      n = 0;
    for (const e of p.past) {
      const pl = planOfActual.get(e.id);
      if (!pl || e.date < from) continue;
      // bevételnél + = több jött; kiadásnál + = többet fizettünk
      sum += Math.abs(e.amount) - Math.abs(pl.amount);
      n++;
    }
    return { sum, n };
  }, [p.past, planOfActual, ix.cur]);
  const years = Object.keys(p.byYear).sort().reverse();
  const secOf = (e: Entry) => ix.sectionOf(e.leaf_id);
  const openDoc = async (id: number) => {
    const w = window.open('', '_blank');
    try {
      const r = await api<{ url: string }>(`/api/billingo/doc/${id}/url`);
      if (w) w.location.href = r.url;
      else window.location.href = r.url;
    } catch (e: any) {
      w?.close();
      alert(e.message || 'Nem sikerült megnyitni a számlát.');
    }
  };
  const past = all ? p.past : p.past.slice(0, 12);
  const sIn = p.sides.in,
    sOut = p.sides.out;
  const net12 = (sIn?.last12 || 0) - (sOut?.last12 || 0);
  const offersSum = (sIn?.offers || 0) + (sOut?.offers || 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!embedded && (
        <button
          onClick={onBack}
          style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', color: C.blueDark, font: `600 14px ${FONT}`, padding: 0, cursor: 'pointer' }}
        >
          ‹ Partnerek
        </button>
      )}
      <div style={embedded ? { display: 'none' } : undefined}>
        <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>
          Partner ·{' '}
          {p.leaves.map((l) => `${ix.sectionOf(l.id) === 'in' ? 'bevétel' : 'kiadás'}: ${displayGroup(ix.groupById[l.group_id]?.label || '')}`).join(' · ')}
        </span>
        <h2 style={{ margin: '2px 0 0', font: `700 ${mobile ? 22 : 28}px/1.1 ${FONT_H}`, color: C.navy }}>{p.name}</h2>
      </div>
      {part !== 'stats' && <NamesBox p={p} />}
      {part !== 'names' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 8 }}>
            {sIn && <Tile label="Bevétel · 12 hó" value={`${fmt(sIn.last12)} Ft`} sub={`${pct(sIn.share12)} az összes bevételből`} />}
            {sOut && <Tile label="Kiadás · 12 hó" value={`${fmt(sOut.last12)} Ft`} sub={`${pct(sOut.share12)} az összes kiadásból`} />}
            {sIn && sOut && <Tile label="Nettó · 12 hó" value={`${net12 > 0 ? '+' : ''}${fmt(net12)} Ft`} red={net12 < 0} />}
            <Tile
              label="Összesen"
              value={`${sIn ? '+' + fmtM(sIn.total) : ''}${sIn && sOut ? ' / ' : ''}${sOut ? '−' + fmtM(sOut.total) : ''}`}
              sub={p.first ? `${dd(p.first)} óta` : undefined}
            />
            <Tile label="Utolsó tény" value={dd(p.last)} sub={`${p.past.length} tétel`} />
            <Tile
              label="Várható"
              value={`${fmt((sIn?.openPlan || 0) - (sOut?.openPlan || 0))} Ft`}
              sub={`${p.future.filter((e) => !e.tentative).length} terv${offersSum ? ` · ajánlat ${fmt(offersSum)}` : ''}`}
              red={!p.future.length && (sIn?.last12 || 0) > 0}
            />
            {p.invoices.length > 0 && (
              <Tile
                label="Fizetési fegyelem"
                value={p.avgLate === null ? '–' : p.avgLate <= 0 ? 'határidőre' : `${Math.round(p.avgLate)} nap késés`}
                sub={p.avgLate === null ? 'nincs fizetett számla' : `átlag · ${p.lateCount} késve fizetett`}
                red={(p.avgLate ?? 0) > 3}
              />
            )}
            {p.invoices.length > 0 && <Tile label="Lejárt kintlévőség" value={`${fmt(p.outstanding)} Ft`} red={p.outstanding > 0} />}
          </div>
          <DivergingBars
            title="Havi egyenleg a partnerrel (bevétel − kiadás) · 24 hónap"
            points={p.months.map((m) => ({ ym: m.ym, v: m.inc - m.out, note: m.out ? `bevétel ${fmt(m.inc)}, kiadás ${fmt(m.out)}` : undefined }))}
          />
          <Box title={`Várható tételek (${p.future.length})`}>
            {p.future.length ? (
              p.future
                .slice(0, 24)
                .map((e) => (
                  <ItemRow key={e.id} e={e} sec={secOf(e)} future onEdit={onEditItem ? () => onEditItem(e.leaf_id, e.series_id || rowKey(e)) : undefined} />
                ))
            ) : (
              <span style={{ font: `500 12.5px ${FONT}`, color: (sIn?.last12 || 0) > 0 ? C.neg : C.muted }}>
                Nincs betervezett jövőbeli tétel{(sIn?.last12 || 0) > 0 ? ' – pedig az elmúlt 12 hónapban volt bevétel.' : '.'}
              </span>
            )}
          </Box>
          {p.futureComponents.length > 0 && (
            <Box title="Várható összetevők">
              <Comps list={p.futureComponents} />
            </Box>
          )}
          {p.pastComponents.length > 0 && (
            <Box title="Múltbeli összetevők (miből állt össze)">
              <Comps list={p.pastComponents} />
            </Box>
          )}
          {years.length > 0 && (
            <Box title="Évenként">
              {years.map((y) => (
                <div
                  key={y}
                  style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.line3}`, font: `500 13.5px ${FONT}`, alignItems: 'baseline' }}
                >
                  <span style={{ flex: 1 }}>
                    {y}
                    {y === String(new Date().getFullYear()) ? ' (eddig)' : ''}
                  </span>
                  {p.byYear[y].inc ? <b style={{ fontVariantNumeric: 'tabular-nums', color: C.navy }}>+{fmt(p.byYear[y].inc)}</b> : null}
                  {p.byYear[y].out ? <b style={{ fontVariantNumeric: 'tabular-nums', color: C.muted }}>−{fmt(p.byYear[y].out)}</b> : null}
                </div>
              ))}
            </Box>
          )}
          {p.invoices.length > 0 && (
            <Box title="Billingo számlák (utolsó 13 hónap)">
              {p.invoices.map((i) => (
                <button
                  key={i.doc.id}
                  onClick={() => openDoc(i.doc.id)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    border: 0,
                    borderTop: `1px solid ${C.line3}`,
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ font: `600 13.5px ${FONT}`, color: C.navy }}>🧾 {i.doc.number}</span>
                    <span style={{ font: `500 12px ${FONT}`, color: i.overdue || (i.lateDays ?? 0) > 0 ? C.neg : C.muted }}>
                      kiállítva {dd(i.doc.invoice_date)} · határidő {dd(i.doc.due_date)} ·{' '}
                      {i.lateDays !== null
                        ? `fizetve ${dd(i.doc.paid_date)}${i.lateDays > 0 ? ` (${i.lateDays} nap késés)` : i.lateDays < 0 ? ` (${-i.lateDays} nappal előbb)` : ' (időben)'}`
                        : i.overdue
                          ? 'LEJÁRT, nincs fizetve'
                          : 'nyitott'}
                    </span>
                  </span>
                  <b style={{ font: `700 13.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(i.doc.gross)}</b>
                </button>
              ))}
            </Box>
          )}
          <Box
            title={`Múltbeli tételek (${p.past.length})${diff12.n ? ` · terv vs. tény (12 hó): ${diffText(diff12.sum)} Ft` : ''}`}
            right={
              p.past.length > 12 ? (
                <button
                  onClick={() => setAll(!all)}
                  style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 12.5px ${FONT}`, cursor: 'pointer' }}
                >
                  {all ? 'Kevesebb' : `Összes (${p.past.length})`}
                </button>
              ) : null
            }
          >
            {past.map((e) => {
              const pl = planOfActual.get(e.id);
              return (
                <ItemRow
                  key={e.id}
                  e={e}
                  sec={secOf(e)}
                  plan={pl}
                  onEdit={pl && onEditItem ? () => onEditItem(pl.leaf_id, pl.series_id || rowKey(pl)) : undefined}
                />
              );
            })}
          </Box>
        </>
      )}
    </div>
  );
}

/** Partnernevek kezelése: átnevezés és összevonás (pl. „Palakovics” + „Palakovics Ferenc”). */
export function PartnerNames() {
  const { ix, run, canEdit } = useStore();
  const stats = usePartners();
  const [side, setSide] = useState<Section>('in');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ key: string; name: string } | null>(null);
  const [merge, setMerge] = useState<string | null>(null);
  const [mq, setMq] = useState('');
  const nq = normalizeText(q);
  const list = stats
    .filter((p) => p.leaves.some((l) => ix.sectionOf(l.id) === side && !l.archived))
    .filter((p) => !nq || normalizeText(p.name).includes(nq))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'));
  const rename = (p: PartnerStat, name: string) =>
    run(
      () => Promise.all(p.leaves.map((l) => api(`/api/leaves/${l.id}`, { method: 'PATCH', body: { label: name.trim() } }))),
      `Átnevezve: ${name.trim()}`,
      () => Promise.all(p.leaves.map((l) => api(`/api/leaves/${l.id}`, { method: 'PATCH', body: { label: l.label } }))),
    );
  const doMerge = (from: PartnerStat, into: PartnerStat) =>
    run(async () => {
      for (const l of from.leaves) {
        const sec = ix.sectionOf(l.id);
        const target = into.leaves.find((t) => ix.sectionOf(t.id) === sec) || into.leaves[0];
        await api(`/api/leaves/${l.id}/merge`, { body: { into: target.id } });
      }
    }, `${from.name} → ${into.name} összevonva`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        A Cash-ben használt partnernevek. <b>Átnevezés</b>: a név mindenhol megváltozik. <b>Összevonás</b>: két név egy partner lesz (pl. „Palakovics” és
        „Palakovics Ferenc”) – a tételek, szabályok és a régi név is átkerül, a rendszer ezután egyként kezeli.
      </span>
      <Seg
        value={side}
        onChange={setSide}
        options={[
          ['in', 'Bejövő (bevétel)'],
          ['out', 'Kimenő (kiadás)'],
        ]}
      />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Keresés…" style={{ ...inputStyle, height: 44 }} />
      {list.map((p) => {
        const st = p.sides[side];
        const isEdit = edit?.key === p.key;
        const isMerge = merge === p.key;
        const cands = isMerge
          ? stats
              .filter((x) => x.key !== p.key && (!mq ? true : normalizeText(x.name).includes(normalizeText(mq))))
              .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
          : [];
        return (
          <div key={p.key} style={{ ...card, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {isEdit ? (
                <input
                  autoFocus
                  value={edit.name}
                  onChange={(e) => setEdit({ key: p.key, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && edit.name.trim()) rename(p, edit.name).then(() => setEdit(null));
                    if (e.key === 'Escape') setEdit(null);
                  }}
                  style={{ ...inputStyle, flex: '1 1 180px', height: 40 }}
                />
              ) : (
                <span style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <PartnerLink leaf={p.key} style={{ font: `700 14.5px ${FONT}`, color: C.navy }}>
                    <b>{p.name}</b>
                  </PartnerLink>
                  <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>
                    {st ? `${st.count} tény · 12 hó: ${fmt(st.last12)} Ft` : 'még nincs tény'}
                    {p.billingNames[0] ? ` · ${p.billingNames[0].name}` : ''}
                  </span>
                </span>
              )}
              {canEdit &&
                (isEdit ? (
                  <>
                    <Pill small kind="primary" onClick={() => edit.name.trim() && rename(p, edit.name).then(() => setEdit(null))}>
                      Mentés
                    </Pill>
                    <Pill small onClick={() => setEdit(null)}>
                      Mégse
                    </Pill>
                  </>
                ) : (
                  <>
                    <Pill small onClick={() => (setEdit({ key: p.key, name: p.name }), setMerge(null))}>
                      Átnevezés
                    </Pill>
                    <Pill small kind="light" onClick={() => (setMerge(isMerge ? null : p.key), setMq(''), setEdit(null))}>
                      {isMerge ? 'Bezár' : 'Összevonás…'}
                    </Pill>
                  </>
                ))}
            </div>
            {isMerge && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${C.line3}`, paddingTop: 8 }}>
                <span style={{ font: `600 12.5px ${FONT}`, color: C.navy }}>Melyik partnerbe vonjuk össze a(z) „{p.name}” nevet?</span>
                <input value={mq} onChange={(e) => setMq(e.target.value)} placeholder="Cél partner keresése…" style={{ ...inputStyle, height: 40 }} />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                  {cands.slice(0, 40).map((t) => (
                    <button
                      key={t.key}
                      onClick={() => confirm(`„${p.name}” összevonása ide: „${t.name}”?`) && doMerge(p, t).then(() => setMerge(null))}
                      style={{
                        border: `1.5px solid ${C.line2}`,
                        background: '#fff',
                        borderRadius: 999,
                        padding: '6px 12px',
                        font: `600 13px ${FONT}`,
                        color: C.navy,
                        cursor: 'pointer',
                      }}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
