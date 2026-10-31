// Asztali partner adatlap (látványterv): fejléc + 3 mutató, fülek: Áttekintés (következő tételek, miből áll, „Hogyan fizet?” naptár),
// Számlák és fizetések (határidő → fizetés, késés), Beállítások (Ki ő? · Mikor fizet?).
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { displayGroup } from '../../shared/categories';
import { fmt, monthLong, ymOf } from '../../shared/model';
import type { PartnerStat } from '../../shared/partners';
import type { Entry } from '../../shared/types';
import { BankPickDialog } from './BankPick';
import { CalendarSheet } from './DatePicker';
import { shiftDate } from './logic';
import { kindOf, PartnerEditor, PartnerTitle, PaymentTerms, PlannedTasks } from './PartnerCard';
import { PartnerDetail } from './PartnersView';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, card } from './ui';

const KIND: Record<string, string> = { vevo: 'Vevő', szallito: 'Szállító', mindketto: 'Vevő és szállító' };
const SM = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];
const dm = (d?: string | null) => (d ? `${d.slice(5, 7)}.${d.slice(8, 10)}.` : '—');
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

type Hist = { ym: string; name: string; amount: number; late: number | null; open: boolean; due: string | null; paid: string | null; number: string | null };

const TONE: Record<string, CSSProperties> = {
  empty: { border: `1.5px dashed ${C.line2}`, background: '#fff' },
  ok: { background: C.blue },
  lt30: { background: '#C3DCEB' },
  lt90: { background: '#EBA799' },
  late: { background: '#B5443A' },
  open: { border: `2.5px solid #B5443A`, background: '#fff' },
};
const tone = (h?: Hist) => (!h ? 'empty' : h.open ? 'open' : h.late == null || h.late <= 0 ? 'ok' : h.late < 30 ? 'lt30' : h.late < 90 ? 'lt90' : 'late');
const lateChip = (h: Hist, today: string): [string, string, string] =>
  h.open
    ? [`nyitott · ${h.due ? Math.max(0, days(h.due, today)) : 0} nap`, '#fff', '#B5443A']
    : h.late == null || h.late <= 0
      ? ['időben', C.blueDark, C.bg2]
      : h.late < 30
        ? [`${h.late} nap`, C.blueDark, '#E3EEF6']
        : [`${h.late} nap késés`, C.neg, '#FBE4DF'];

export function PartnerSheet({
  p,
  onClose,
  onNewItem,
  onEditItem,
  onRenamed,
}: {
  p: PartnerStat;
  onClose: () => void;
  onNewItem: (leaf: string) => void;
  onEditItem: (leaf: string, key?: string) => void;
  onRenamed: (key: string) => void;
}) {
  const { data, ix, commit, canEdit } = useStore();
  const [tab, setTab] = useState<'main' | 'inv' | 'set'>('main');
  const [filter, setFilter] = useState<'all' | 'late' | 'open'>('all');
  const [pick, setPick] = useState<string | null>(null);
  const [dateFor, setDateFor] = useState<Entry | null>(null);
  const [bankFor, setBankFor] = useState<Entry | null>(null);
  const byId = useMemo(() => new Map(data.entries.map((e) => [e.id, e])), [data.entries]);
  const sec = p.sides.in ? 'in' : 'out';
  const side = p.sides.in || p.sides.out;
  const leaf = p.leaves[0]?.id;
  const group = p.groups[0] ? displayGroup(p.groups[0].label) : '';
  const company = p.info?.aliases?.find((a) => a !== p.name) || p.billingNames.find((b) => b.name !== p.name)?.name;

  // számlák: határidő → fizetés, késéssel; számla nélkül a tények
  const hist: Hist[] = useMemo(() => {
    if (p.invoices.length)
      return p.invoices
        .map((i) => {
          const pl = i.doc.plan_id ? byId.get(i.doc.plan_id) : undefined;
          return {
            ym: (i.doc.invoice_date || i.doc.due_date || '').slice(0, 7),
            name: (pl?.name || 'Számla').replace(/\s*·\s*Penge.*$/i, ''),
            amount: i.doc.gross,
            late: i.lateDays,
            open: i.lateDays === null,
            due: i.doc.due_date,
            paid: i.doc.paid_date,
            number: i.doc.number,
          };
        })
        .filter((h) => h.ym)
        .sort((a, b) => b.ym.localeCompare(a.ym));
    return p.past
      .map((e) => ({ ym: ymOf(e.date), name: e.name || 'tény', amount: Math.abs(e.amount), late: 0, open: false, due: e.date, paid: e.date, number: null }))
      .sort((a, b) => b.ym.localeCompare(a.ym));
  }, [p, byId]);

  const openItems = p.future.filter((e) => e.kind === 'plan' && !e.done).sort((a, b) => a.date.localeCompare(b.date));
  const lateNow = p.outstanding || openItems.filter((e) => e.date < data.today).reduce((a, e) => a + Math.abs(e.amount), 0);
  const lateHist = hist.filter((h) => !h.open && h.late != null && h.late > 0);
  const openHist = hist.filter((h) => h.open);
  const plusMonth = (e: Entry) =>
    commit({ upsert: [{ ...e, date: shiftDate(e.date, 1), period: e.period || ymOf(e.date) }] }, `${p.name}: +1 hó (${dm(shiftDate(e.date, 1))})`);

  const stat = (label: string, value: string, red?: boolean) => (
    <div
      style={{
        flex: 1,
        minWidth: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '18px 22px',
        borderRadius: 14,
        background: red ? '#FBE9E5' : C.bg,
      }}
    >
      <span style={{ font: `500 14px ${FONT}`, color: red ? C.neg : C.muted }}>{label}</span>
      <b style={{ font: `800 26px ${FONT_H}`, color: red ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</b>
    </div>
  );

  return (
    <div style={{ padding: '26px 30px 30px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <PartnerTitle p={p} onSaved={onRenamed} />
            <span style={{ padding: '4px 12px', borderRadius: 999, background: C.bg2, color: C.blueDark, font: `600 13px ${FONT}` }}>
              {KIND[kindOf(p, ix.sectionOf)]}
              {group ? ` · ${group}` : ''}
            </span>
          </div>
          {(company || p.info?.tax_number) && (
            <span style={{ font: `400 14px ${FONT}`, color: C.muted }}>
              {[company, p.info?.tax_number ? `adószám ${p.info.tax_number}` : ''].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {canEdit && leaf && (
          <button
            type="button"
            className="hov-primary"
            onClick={() => onNewItem(leaf)}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '11px 20px', font: `600 14px ${FONT}`, cursor: 'pointer' }}
          >
            + Új tétel
          </button>
        )}
        <Pill onClick={onClose}>Bezár</Pill>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {stat(sec === 'in' ? 'Lejárt kintlévőség' : 'Lejárt tartozás', `${fmt(lateNow)} Ft`, lateNow > 0)}
        {stat('Átlagos késés', p.avgLate == null ? '–' : `${Math.round(p.avgLate)} nap`)}
        {stat(`${sec === 'in' ? 'Bevétel' : 'Kiadás'} · 12 hó`, `${fmt(side?.last12 || 0)} Ft`)}
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.line}` }}>
        {(
          [
            ['main', 'Áttekintés'],
            ['inv', 'Számlák és fizetések'],
            ['set', 'Beállítások'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            style={{
              border: 0,
              background: 'transparent',
              padding: '10px 26px 12px',
              font: `600 15px ${FONT}`,
              color: tab === k ? C.navy : C.muted,
              borderBottom: `3px solid ${tab === k ? C.blue : 'transparent'}`,
              marginBottom: -1,
              cursor: 'pointer',
            }}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'main' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(300px,1fr)', gap: 20, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <Head title="Következő tételek" right={`${openItems.length} nyitott`} />
            {openItems.length === 0 && <span style={{ ...card, padding: 16, font: `500 14px ${FONT}`, color: C.muted }}>Nincs nyitott tétel.</span>}
            {openItems.slice(0, 5).map((e) => {
              const late = e.date < data.today;
              const inv = data.billingo.find((d) => d.plan_id === e.id)?.number;
              return (
                <div key={e.id} style={{ ...card, overflow: 'hidden', background: late ? '#FDF5F3' : '#fff', borderColor: late ? '#F3D9D3' : C.line }}>
                  <div
                    onClick={() => onEditItem(e.leaf_id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', cursor: 'pointer' }}
                  >
                    <b style={{ font: `700 15px ${FONT_H}`, color: late ? C.neg : C.navy, width: 52 }}>{dm(e.date)}</b>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <b style={{ font: `600 16px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.name || p.name}
                      </b>
                      {inv && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>{inv}</span>}
                    </span>
                    {late && (
                      <span style={{ padding: '3px 12px', borderRadius: 999, background: '#FBE4DF', color: C.neg, font: `600 13px ${FONT}` }}>
                        {days(e.date, data.today)} napja lejárt
                      </span>
                    )}
                    {e.tentative ? <span style={{ font: `600 12px ${FONT}`, color: C.muted }}>ajánlat</span> : null}
                    <b style={{ font: `700 16px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums', minWidth: 90, textAlign: 'right' }}>
                      {fmt(Math.abs(e.amount))}
                    </b>
                  </div>
                  {canEdit && !e.tentative && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderTop: `1px solid ${late ? '#F3D9D3' : C.line3}` }}>
                      <Btn dark onClick={() => setBankFor(e)}>
                        ⇄ Bank párosítás
                      </Btn>
                      <Btn onClick={() => setDateFor(e)}>▭ Dátum</Btn>
                      <Btn onClick={() => plusMonth(e)}>+1 hó</Btn>
                    </div>
                  )}
                </div>
              );
            })}

            {p.pastComponents.length > 0 && (
              <>
                <Head
                  title={`Miből áll a ${sec === 'in' ? 'bevétel' : 'kiadás'}`}
                  right={`${p.first ? p.first.slice(0, 7).replace('-', '.') + '. óta · ' : ''}${(p.pastComponents.reduce((a, c) => a + c.total, 0) >= 0 ? '+' : '−') + (Math.abs(p.pastComponents.reduce((a, c) => a + c.total, 0)) / 1e6).toLocaleString('hu-HU', { maximumFractionDigits: 2 })} M`}
                />
                <Composition comps={p.pastComponents} />
              </>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <PayCalendar hist={hist} pick={pick} setPick={setPick} />
          </div>
        </div>
      )}

      {tab === 'inv' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {(
              [
                ['all', `Mind ${hist.length}`],
                ['late', `Késve fizetett ${lateHist.length}`],
                ['open', `Nyitott ${openHist.length}`],
              ] as const
            ).map(([k, l]) => (
              <Btn key={k} dark={filter === k} onClick={() => setFilter(k)}>
                {l}
              </Btn>
            ))}
            <span style={{ marginLeft: 'auto', font: `400 14px ${FONT}`, color: C.muted }}>
              {Object.keys(p.byYear)
                .sort()
                .reverse()
                .slice(0, 2)
                .map((y, i) => {
                  const v = sec === 'in' ? p.byYear[y].inc : p.byYear[y].out;
                  return (
                    <span key={y}>
                      {i ? ' · ' : ''}
                      {y}
                      {y === ix.cur.slice(0, 4) ? ' eddig' : ''} <b style={{ color: C.navy }}>{(sec === 'in' ? '+' : '−') + fmt(Math.abs(v))}</b>
                    </span>
                  );
                })}
            </span>
          </div>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: INV_COLS, gap: 12, padding: '14px 22px', borderBottom: `1px solid ${C.line}` }}>
              {['Hónap', 'Tétel', 'Számla', 'Határidő', 'Fizetve', 'Késés', 'Összeg'].map((t, i) => (
                <span
                  key={t}
                  style={{
                    font: `600 12px ${FONT}`,
                    letterSpacing: '.12em',
                    textTransform: 'uppercase',
                    color: C.muted,
                    textAlign: i === 6 ? 'right' : 'left',
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
            {(filter === 'late' ? lateHist : filter === 'open' ? openHist : hist).map((h, i) => {
              const [cl, cc, cb] = lateChip(h, data.today);
              return (
                <div
                  key={i}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: INV_COLS,
                    gap: 12,
                    alignItems: 'center',
                    padding: '14px 22px',
                    borderTop: i ? `1px solid ${C.line3}` : 0,
                    background: h.open ? '#FDF5F3' : '#fff',
                  }}
                >
                  <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>
                    {h.ym.slice(0, 4)} {SM[Number(h.ym.slice(5, 7)) - 1]}
                  </b>
                  <span style={{ font: `400 15px ${FONT}`, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                  <span style={{ font: `400 15px ${FONT}`, color: h.number ? C.blueDark : C.faint }}>{h.number || '–'}</span>
                  <span style={{ font: `400 15px ${FONT}`, color: C.muted }}>{dm(h.due)}</span>
                  <span style={{ font: `400 15px ${FONT}`, color: C.muted }}>{h.open ? '—' : dm(h.paid)}</span>
                  <span>
                    <span style={{ padding: '3px 12px', borderRadius: 999, background: cb, color: cc, font: `600 13px ${FONT}`, whiteSpace: 'nowrap' }}>
                      {cl}
                    </span>
                  </span>
                  <b style={{ font: `700 15px ${FONT}`, color: C.navy, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(h.amount)}</b>
                </div>
              );
            })}
            {!hist.length && <span style={{ display: 'block', padding: 18, font: `500 14px ${FONT}`, color: C.muted }}>Még nincs számla vagy fizetés.</span>}
          </div>
        </div>
      )}

      {tab === 'set' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 18, alignItems: 'start' }}>
          <div style={{ ...card, padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Ki ő?</b>
            <PartnerEditor key={p.key + (p.info?.updated_at || 0)} p={p} part="company" onSaved={onRenamed} />
            <PartnerDetail p={p} embedded part="names" onBack={onClose} />
          </div>
          <div style={{ ...card, padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Mikor fizet?</b>
            <PaymentTerms p={p} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <PlannedTasks p={p} onEdit={onEditItem} />
          </div>
        </div>
      )}

      {dateFor && (
        <CalendarSheet
          value={dateFor.date}
          onClose={() => setDateFor(null)}
          onPick={(v) => {
            const e = dateFor;
            setDateFor(null);
            if (v !== e.date)
              commit(
                { upsert: [{ ...e, date: v, ...(e.series_id ? { period: e.period || ymOf(e.date) } : {}) }] },
                `${p.name}: fizetési határidő ${v.replace(/-/g, '.')}.`,
              );
          }}
        />
      )}
      {bankFor && <BankPickDialog plan={bankFor} onClose={() => setBankFor(null)} />}
    </div>
  );
}

const INV_COLS = '110px minmax(0,1.4fr) minmax(0,1.1fr) 90px 90px 150px 100px';

function Head({ title, right }: { title: string; right?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
      <b style={{ font: `700 19px ${FONT_H}`, color: C.navy }}>{title}</b>
      {right && <span style={{ font: `400 14px ${FONT}`, color: C.muted }}>{right}</span>}
    </div>
  );
}

function Btn({ children, onClick, dark }: { children: ReactNode; onClick: () => void; dark?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: dark ? 0 : `1px solid ${C.line2}`,
        borderRadius: 999,
        background: dark ? C.navy : '#fff',
        color: dark ? '#fff' : C.navy,
        padding: '8px 18px',
        font: `600 14px ${FONT}`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

/** Miből áll a bevétel: tételnév szerinti arányos sáv + jelmagyarázat. */
function Composition({ comps }: { comps: PartnerStat['pastComponents'] }) {
  const list = [...comps].filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const top = list.slice(0, 4);
  const rest = list.slice(4).reduce((a, c) => a + c.total, 0);
  const parts = rest > 0 ? [...top, { name: 'egyéb', total: rest, count: list.slice(4).reduce((a, c) => a + c.count, 0) }] : top;
  const sum = parts.reduce((a, c) => a + c.total, 0) || 1;
  const COL = [C.blue, '#C3DCEB', '#7FB3D5', '#E3EEF6', C.line2];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 4, height: 20 }}>
        {parts.map((c, i) => (
          <span
            key={c.name}
            title={`${c.name}: ${fmt(c.total)} Ft`}
            style={{ flex: c.total / sum, background: COL[i % COL.length], borderRadius: 6, minWidth: 6 }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', font: `400 15px ${FONT}`, color: C.ink }}>
        {parts.map((c, i) => (
          <span key={c.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i style={{ width: 13, height: 13, borderRadius: 3, background: COL[i % COL.length], display: 'inline-block' }} />
            {c.name} · {c.count} db · <b style={{ color: C.navy }}>{fmt(c.total)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** „Hogyan fizet?”: év × hónap rács a számla késése szerint, alatta a kiválasztott hónap részletei. */
function PayCalendar({ hist, pick, setPick }: { hist: Hist[]; pick: string | null; setPick: (ym: string) => void }) {
  const { ix } = useStore();
  const byYm = new Map<string, Hist>();
  for (const h of hist) if (!byYm.has(h.ym)) byYm.set(h.ym, h);
  const years = [...new Set(hist.map((h) => h.ym.slice(0, 4)))].sort().slice(-2);
  if (!years.length) years.push(ix.cur.slice(0, 4));
  // alapból a legutóbbi késve fizetett (vagy a legutóbbi) számla hónapja
  const sel = byYm.get(pick || '') || hist.find((h) => !h.open && h.late != null && h.late > 0) || hist[0];
  const selYm = sel?.ym;
  const [cl, cc, cb] = sel ? lateChip(sel, ix.cur + '-01') : ['', '', ''];
  return (
    <>
      <Head title="Hogyan fizet?" right={`${byYm.size} számla`} />
      <div style={{ ...card, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(12,1fr)`, gap: 5, alignItems: 'center' }}>
          <span />
          {['J', 'F', 'M', 'Á', 'M', 'J', 'J', 'A', 'Sz', 'O', 'N', 'D'].map((d, i) => (
            <span key={i} style={{ textAlign: 'center', font: `500 12px ${FONT}`, color: C.muted }}>
              {d}
            </span>
          ))}
          {years.map((y) => [
            <span key={y} style={{ font: `500 14px ${FONT}`, color: C.ink }}>
              {y}
            </span>,
            ...Array.from({ length: 12 }, (_, i) => {
              const ym = `${y}-${String(i + 1).padStart(2, '0')}`;
              const h = byYm.get(ym);
              return (
                <button
                  key={ym}
                  onClick={() => h && setPick(ym)}
                  title={h ? `${monthLong(ym)}: ${lateChip(h, ix.cur + '-01')[0]}` : monthLong(ym)}
                  style={{
                    aspectRatio: '1',
                    borderRadius: 7,
                    border: 0,
                    padding: 0,
                    cursor: h ? 'pointer' : 'default',
                    outline: selYm === ym ? `2.5px solid ${C.navy}` : undefined,
                    outlineOffset: 1.5,
                    ...TONE[tone(h)],
                  }}
                />
              );
            }),
          ])}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', font: `400 13.5px ${FONT}`, color: C.ink }}>
          {(
            [
              ['ok', 'időben'],
              ['lt30', '<30 nap'],
              ['lt90', '30–90'],
              ['late', '90+'],
              ['open', 'nyitott'],
            ] as const
          ).map(([k, l]) => (
            <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 13, height: 13, borderRadius: 3, display: 'inline-block', boxSizing: 'border-box', ...TONE[k] }} />
              {l}
            </span>
          ))}
        </div>
      </div>
      {sel && (
        <div style={{ ...card, border: `2px solid ${C.navy}`, padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <b style={{ font: `700 17px ${FONT_H}`, color: C.navy }}>
              {sel.ym.slice(0, 4)}. {SM[Number(sel.ym.slice(5, 7)) - 1]} · {sel.name}
            </b>
            <b style={{ font: `700 17px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(sel.amount)}</b>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 14, alignItems: 'center' }}>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.12em', color: C.muted }}>HATÁRIDŐ</span>
              <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{dm(sel.due)}</b>
            </span>
            <span style={{ height: 4, borderRadius: 2, background: tone(sel) === 'ok' ? C.blue : `linear-gradient(90deg, ${C.blue} 0 8%, #B5443A 8% 100%)` }} />
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.12em', color: C.muted }}>{sel.open ? 'NYITOTT' : 'FIZETVE'}</span>
              <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{sel.open ? '—' : dm(sel.paid)}</b>
            </span>
          </div>
          <span style={{ alignSelf: 'flex-start', padding: '5px 14px', borderRadius: 999, background: cb, color: cc, font: `600 13.5px ${FONT}` }}>
            {cl}
            {sel.number ? ` · ${sel.number}` : ''}
          </span>
        </div>
      )}
    </>
  );
}
