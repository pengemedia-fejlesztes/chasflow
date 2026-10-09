// Partnerek: egy partner = a Cash-ben használt név (bevételi és kiadási oldalon is). Az adatlapon a számlázási
// (cég)nevek, a múltbeli tények, a várható tételek, az összetevők, a Billingo számlák és a fizetési fegyelem látszik.
import { useMemo, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { fmt, fmtM } from '../../shared/model';
import { partnerStats, type Component, type PartnerStat } from '../../shared/partners';
import type { Entry, Section } from '../../shared/types';
import { api } from './api';
import { DivergingBars } from './Bars';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, Seg, card, inputStyle } from './ui';

const dd = (d: string | null | undefined) => (d ? d.replace(/-/g, '.') + '.' : '–');
const pct = (v: number) => `${Math.round(v * 100)}%`;
type Side = 'in' | 'out' | 'all';

export function usePartners() {
  const { data, ix } = useStore();
  return useMemo(
    () => partnerStats(data.entries, ix.leaves, ix.groups, data.billingo, data.today, data.partnerNames || []),
    [data.entries, data.billingo, data.today, data.partnerNames, ix],
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
  const [sel, setSel] = useState<string | null>(initialKey || null);
  const [side, setSide] = useState<Side>('in');
  const [sort, setSort] = useState<'last12' | 'total'>('last12');
  const [q, setQ] = useState('');
  const cur = sel ? stats.find((p) => p.key === sel) : null;
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
            onClick={() => setSel(p.key)}
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
        borderRadius: 12,
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

function ItemRow({ e, sec, future }: { e: Entry; sec: Section; future?: boolean }) {
  const { data } = useStore();
  const late = future && !e.tentative && e.date < data.today;
  return (
    <div style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
      <span style={{ font: `500 12.5px ${FONT}`, color: late ? C.neg : C.muted, width: 84, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
        {dd(e.date)}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ font: `500 13.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name || '–'}</span>
        <span style={{ font: `500 11px ${FONT}`, color: late ? C.neg : C.muted }}>
          {sec === 'in' ? 'bevétel' : 'kiadás'}
          {future ? (e.tentative ? ' · ajánlat' : late ? ' · lejárt terv' : ' · terv') : ''}
        </span>
      </span>
      <b style={{ font: `700 13.5px ${FONT}`, color: sec === 'in' ? C.navy : C.muted, fontVariantNumeric: 'tabular-nums' }}>
        {sec === 'in' ? '+' : '−'}
        {fmt(Math.abs(e.amount))}
      </b>
    </div>
  );
}

function Comps({ list }: { list: Component[] }) {
  const tot = list.reduce((s, c) => s + c.total, 0) || 1;
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
            <b style={{ font: `700 13px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(c.total)}</b>
          </div>
          <div style={{ height: 4, borderRadius: 999, background: C.line3 }}>
            <div style={{ width: pct(c.total / tot), height: '100%', borderRadius: 999, background: c.section === 'in' ? C.blue : C.muted2 }} />
          </div>
        </div>
      ))}
    </>
  );
}

export function PartnerDetail({ p, mobile, onBack }: { p: PartnerStat; mobile?: boolean; onBack: () => void }) {
  const { ix } = useStore();
  const [all, setAll] = useState(false);
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
      <button
        onClick={onBack}
        style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', color: C.blueDark, font: `600 14px ${FONT}`, padding: 0, cursor: 'pointer' }}
      >
        ‹ Partnerek
      </button>
      <div>
        <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>
          Partner ·{' '}
          {p.leaves.map((l) => `${ix.sectionOf(l.id) === 'in' ? 'bevétel' : 'kiadás'}: ${displayGroup(ix.groupById[l.group_id]?.label || '')}`).join(' · ')}
        </span>
        <h2 style={{ margin: '2px 0 0', font: `700 ${mobile ? 22 : 28}px/1.1 ${FONT_H}`, color: C.navy }}>{p.name}</h2>
      </div>
      <Box title="Számlázási nevek (cégadat)">
        {p.billingNames.length ? (
          p.billingNames.map((b) => (
            <div key={b.source + b.name} style={{ display: 'flex', gap: 8, padding: '6px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
              <span style={{ flex: 1, font: `600 13.5px ${FONT}`, color: C.ink }}>{b.name}</span>
              <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>
                {b.source} · {b.n}×
              </span>
            </div>
          ))
        ) : (
          <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>Még nincs Billingo-számla vagy jóváhagyott banki tétel ezzel a partnerrel.</span>
        )}
      </Box>
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
          p.future.slice(0, 24).map((e) => <ItemRow key={e.id} e={e} sec={secOf(e)} future />)
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
        title={`Múltbeli tételek (${p.past.length})`}
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
        {past.map((e) => (
          <ItemRow key={e.id} e={e} sec={secOf(e)} />
        ))}
      </Box>
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
                  <b style={{ font: `700 14.5px ${FONT}`, color: C.navy }}>{p.name}</b>
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
