// Partnerek: statisztika partnerenként (bevétel / kiadás), fizetési előzmények, Billingo számlák és késések.
import { useMemo, useState } from 'react';
import { normalizeText, displayGroup } from '../../shared/categories';
import { fmt, fmtM, monthLabel } from '../../shared/model';
import { partnerStats, type PartnerStat } from '../../shared/partners';
import type { Section } from '../../shared/types';
import { api } from './api';
import { useStore } from './store';
import { C, FONT, FONT_H, Seg, card, inputStyle } from './ui';

const dd = (d: string | null | undefined) => (d ? d.replace(/-/g, '.') + '.' : '–');
const pct = (v: number) => `${Math.round(v * 100)}%`;

function trend(p: PartnerStat) {
  if (!p.prev12) return p.last12 ? { t: 'új', bad: false } : null;
  const ch = (p.last12 - p.prev12) / p.prev12;
  // bevételnél a csökkenés, kiadásnál a növekedés kedvezőtlen
  return { t: `${ch > 0 ? '+' : ''}${Math.round(ch * 100)}%`, bad: p.section === 'in' ? ch < -0.05 : ch > 0.05 };
}

export function PartnersView({ mobile, initialLeaf, onBack }: { mobile?: boolean; initialLeaf?: string | null; onBack?: () => void }) {
  const { data, ix } = useStore();
  const stats = useMemo(() => partnerStats(data.entries, ix.leaves, ix.groups, data.billingo, data.today), [data.entries, data.billingo, data.today, ix]);
  const [sel, setSel] = useState<string | null>(initialLeaf || null);
  const [side, setSide] = useState<Section>(() => (initialLeaf ? ix.sectionOf(initialLeaf) : 'in'));
  const [sort, setSort] = useState<'last12' | 'total'>('last12');
  const [q, setQ] = useState('');
  const cur = sel ? stats.find((p) => p.leaf.id === sel) : null;
  if (cur) return <PartnerDetail p={cur} mobile={mobile} onBack={() => (initialLeaf && onBack ? onBack() : setSel(null))} />;

  const nq = normalizeText(q);
  const list = stats
    .filter((p) => p.section === side && (p.total || p.openPlan || p.invoices.length))
    .filter((p) => !nq || normalizeText(p.leaf.label + ' ' + (p.group?.label || '')).includes(nq))
    .sort((a, b) => b[sort] - a[sort] || b.total - a.total);
  const sum12 = list.reduce((s, p) => s + p.last12, 0);

  return (
    <div style={{ padding: mobile ? '14px 16px 24px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1000 }}>
      {!mobile && (
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>Statisztika</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Partnerek</h1>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg
          value={side}
          onChange={setSide}
          options={[
            ['in', 'Bevétel (ügyfelek)'],
            ['out', 'Kiadás (szállítók)'],
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
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Partner keresése…" style={{ ...inputStyle, height: 44 }} />
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
        {list.length} partner · utolsó 12 hónap: <b style={{ color: C.navy }}>{fmt(sum12)} Ft</b> {side === 'in' ? 'bevétel' : 'kiadás'}
      </span>
      {list.map((p) => {
        const tr = trend(p);
        return (
          <button
            key={p.leaf.id}
            onClick={() => setSel(p.leaf.id)}
            style={{
              ...card,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              textAlign: 'left',
              cursor: 'pointer',
              borderColor: p.outstanding ? C.negLight : C.line,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%' }}>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <b style={{ font: `700 15px ${FONT}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.leaf.label}</b>
                <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                  {displayGroup(p.group?.label || '')} · {p.count} fizetés · utolsó: {dd(p.last)}
                </span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <b style={{ font: `700 15px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(sort === 'total' ? p.total : p.last12)}</b>
                <span style={{ font: `600 11.5px ${FONT}`, color: tr?.bad ? C.neg : C.muted }}>
                  {sort === 'total' ? 'összesen' : '12 hó'}
                  {tr && sort === 'last12' ? ` · ${tr.t}` : ''}
                </span>
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <div style={{ flex: 1, height: 6, borderRadius: 999, background: C.line3, overflow: 'hidden' }}>
                <div style={{ width: pct(Math.min(1, p.share12)), height: '100%', borderRadius: 999, background: C.blue }} />
              </div>
              <span style={{ font: `600 11.5px ${FONT}`, color: C.muted, minWidth: 34, textAlign: 'right' }}>{pct(p.share12)}</span>
            </div>
            {(p.outstanding > 0 || (p.avgLate !== null && p.avgLate > 3)) && (
              <span style={{ font: `600 12px ${FONT}`, color: C.neg }}>
                {p.outstanding > 0 ? `Lejárt kintlévőség: ${fmt(p.outstanding)} Ft` : ''}
                {p.outstanding > 0 && p.avgLate !== null && p.avgLate > 3 ? ' · ' : ''}
                {p.avgLate !== null && p.avgLate > 3 ? `átlagosan ${Math.round(p.avgLate)} nap késés` : ''}
              </span>
            )}
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
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      }}
    >
      <span style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted }}>{label}</span>
      <b style={{ font: `700 17px ${FONT_H}`, color: red ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</b>
      {sub && <span style={{ font: `500 11.5px ${FONT}`, color: red ? C.neg : C.muted }}>{sub}</span>}
    </div>
  );
}

/** Havi oszlopdiagram (24 hónap) – egy sorozat, koppintásra / rámutatásra érték. */
function MonthBars({ p }: { p: PartnerStat }) {
  const [hi, setHi] = useState<number | null>(null);
  const max = Math.max(...p.months.map((m) => m.v), 1);
  const H = 110;
  const shown = hi !== null ? p.months[hi] : null;
  return (
    <div style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>Havi {p.section === 'in' ? 'befizetések' : 'kifizetések'} · 24 hónap</b>
        <span style={{ font: `600 12.5px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
          {shown ? `${shown.ym.replace('-', '. ')}.: ${fmt(shown.v)} Ft` : `max ${fmt(max)} Ft`}
        </span>
      </div>
      <div
        style={{ position: 'relative', height: H, display: 'flex', alignItems: 'flex-end', gap: 2, borderBottom: `1px solid ${C.line}` }}
        onMouseLeave={() => setHi(null)}
      >
        {p.months.map((m, i) => (
          <div
            key={m.ym}
            onMouseEnter={() => setHi(i)}
            onClick={() => setHi(hi === i ? null : i)}
            title={`${m.ym}: ${fmt(m.v)} Ft`}
            style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', cursor: 'pointer' }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: 24,
                height: m.v > 0 ? Math.max(3, Math.round((m.v / max) * (H - 4))) : 0,
                borderRadius: '4px 4px 0 0',
                background: C.blue,
                opacity: hi === null || hi === i ? 1 : 0.45,
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ position: 'relative', height: 14 }}>
        {p.months.map((m, i) =>
          i % 6 === 0 ? (
            <span
              key={m.ym}
              style={{
                position: 'absolute',
                left: `${(i / p.months.length) * 100}%`,
                font: `500 10.5px ${FONT}`,
                color: C.muted,
                whiteSpace: 'nowrap',
              }}
            >
              {m.ym.slice(0, 4)}. {monthLabel(m.ym).toLowerCase()}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function PartnerDetail({ p, mobile, onBack }: { p: PartnerStat; mobile?: boolean; onBack: () => void }) {
  const [all, setAll] = useState(false);
  const tr = trend(p);
  const years = Object.keys(p.byYear).sort().reverse();
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
  const acts = all ? p.actuals : p.actuals.slice(0, 12);
  const sign = p.section === 'in' ? 1 : -1;
  return (
    <div style={{ padding: mobile ? '14px 16px 24px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1000 }}>
      <button
        onClick={onBack}
        style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', color: C.blueDark, font: `600 14px ${FONT}`, padding: 0, cursor: 'pointer' }}
      >
        ‹ Partnerek
      </button>
      <div>
        <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>
          {p.section === 'in' ? 'Bevétel' : 'Kiadás'} · {displayGroup(p.group?.label || '')}
        </span>
        <h2 style={{ margin: '2px 0 0', font: `700 ${mobile ? 22 : 28}px/1.1 ${FONT_H}`, color: C.navy }}>{p.leaf.label}</h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 8 }}>
        <Tile label="Utolsó 12 hónap" value={`${fmt(p.last12)} Ft`} sub={tr ? `előző 12 hóhoz: ${tr.t}` : undefined} red={tr?.bad} />
        <Tile label="Összesen" value={fmtM(p.total)} sub={p.first ? `${dd(p.first)} óta` : undefined} />
        <Tile label="Részesedés (12 hó)" value={pct(p.share12)} sub={p.section === 'in' ? 'az összes bevételből' : 'az összes kiadásból'} />
        <Tile label="Fizetések" value={`${p.count} db`} sub={p.count ? `átlag ${fmt(p.avgPayment)} Ft` : undefined} />
        <Tile label="Utolsó fizetés" value={dd(p.last)} />
        <Tile
          label="Nyitott terv"
          value={`${fmt(p.openPlan)} Ft`}
          sub={p.nextPlan ? `következő: ${dd(p.nextPlan.date)}` : 'nincs betervezve'}
          red={!p.openPlan && p.last12 > 0}
        />
        {p.invoices.length > 0 && (
          <Tile
            label="Fizetési fegyelem"
            value={p.avgLate === null ? '–' : p.avgLate <= 0 ? 'határidőre' : `${Math.round(p.avgLate)} nap késés`}
            sub={p.avgLate === null ? 'nincs fizetett számla' : `átlag · ${p.lateCount} késve fizetett számla`}
            red={(p.avgLate ?? 0) > 3}
          />
        )}
        {p.invoices.length > 0 && <Tile label="Lejárt kintlévőség" value={`${fmt(p.outstanding)} Ft`} red={p.outstanding > 0} />}
      </div>
      <MonthBars p={p} />
      {years.length > 0 && (
        <div style={{ ...card, padding: '10px 14px' }}>
          <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>Évenként</b>
          {years.map((y) => (
            <div
              key={y}
              style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${C.line3}`, font: `500 13.5px ${FONT}` }}
            >
              <span>
                {y}
                {y === String(new Date().getFullYear()) ? ' (eddig)' : ''}
              </span>
              <b style={{ fontVariantNumeric: 'tabular-nums', color: C.navy }}>{fmt(p.byYear[y])} Ft</b>
            </div>
          ))}
        </div>
      )}
      {p.invoices.length > 0 && (
        <div style={{ ...card, padding: '10px 14px' }}>
          <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>Billingo számlák (utolsó 13 hónap)</b>
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
        </div>
      )}
      <div style={{ ...card, padding: '10px 14px' }}>
        <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>Fizetési előzmények ({p.actuals.length})</b>
        {acts.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, width: 84, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{dd(e.date)}</span>
            <span
              style={{ flex: 1, minWidth: 0, font: `500 13.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {e.name || p.leaf.label}
            </span>
            <b style={{ font: `700 13.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount * sign)}</b>
          </div>
        ))}
        {p.actuals.length > 12 && (
          <button
            onClick={() => setAll(!all)}
            style={{ marginTop: 6, border: 0, background: 'transparent', color: C.blueDark, font: `600 13px ${FONT}`, padding: 0, cursor: 'pointer' }}
          >
            {all ? 'Kevesebb' : `Összes (${p.actuals.length}) megjelenítése`}
          </button>
        )}
      </div>
    </div>
  );
}
