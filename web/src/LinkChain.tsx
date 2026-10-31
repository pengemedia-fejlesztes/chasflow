// Egy terv teljes útja: terv → Billingo-számla (kimenő) / NAV-számla (bejövő) → banki tétel → tény, és a tény − terv különbség.
// A terv összege soha nem változik a számla vagy a tény miatt, így az eltérés mindig látszik.
import { useMemo } from 'react';
import { fmt } from '../../shared/model';
import type { DataBundle, Entry, Section } from '../../shared/types';
import { openBillingoDoc } from './logic';
import { useStore } from './store';
import { C, FONT, R } from './ui';

export interface PlanLink {
  plan: Entry;
  actual: Entry | null;
  /** tény − terv, abszolút értékekkel (bevételnél + = több jött, kiadásnál + = többet fizettünk) */
  diff: number | null;
}

/** A tervhez kötött tény (a terv link_id-ja, vagy a tény link_id-ja mutat a tervre). */
export function actualOf(d: Pick<DataBundle, 'entries'>, plan: Entry, byId?: Map<string, Entry>): Entry | null {
  const m = byId || new Map(d.entries.map((e) => [e.id, e]));
  const a = plan.link_id ? m.get(plan.link_id) : null;
  return a && a.kind === 'actual' ? a : null;
}

/** Lezárt tervek a tényükkel és az eltéréssel (tény − terv). */
export function planLinks(entries: Entry[], filter: (e: Entry) => boolean = () => true): PlanLink[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: PlanLink[] = [];
  for (const e of entries) {
    if (e.kind !== 'plan' || !e.done || !e.link_id || !filter(e)) continue;
    const a = byId.get(e.link_id);
    if (!a || a.kind !== 'actual') continue;
    out.push({ plan: e, actual: a, diff: Math.abs(a.amount) - Math.abs(e.amount) });
  }
  return out;
}

/** Az eltérés színe: bevételnél a több jó (zöld), kiadásnál a több rossz (piros). */
export const diffColor = (sec: Section | undefined, diff: number) => (!diff ? C.muted : diff > 0 === (sec !== 'out') ? C.inc : C.neg);
export const diffText = (diff: number) => (diff > 0 ? '+' : diff < 0 ? '−' : '±') + fmt(Math.abs(diff));

const dot = (d?: string | null) => (d ? d.replace(/-/g, '.') + '.' : '');

/** Kompakt sor egy tervhez: terv · számla · NAV · bank · tény · különbség (a számla megnyitható). */
export function LinkChain({ plan }: { plan: Entry }) {
  const { data, ix } = useStore();
  const sec = ix.sectionOf(plan.leaf_id);
  const actual = actualOf(data, plan);
  const doc = data.billingo.find((d) => d.plan_id === plan.id);
  const nav = (data.navInvoices || []).find((n) => n.plan_id === plan.id || (actual && n.actual_id === actual.id));
  const tx = actual ? data.bankTx.find((t) => t.actual_id === actual.id || actual.ext_ref === 'bank:' + t.id) : null;
  const acc = tx ? data.accounts.find((a) => a.id === tx.account_id) : null;
  const diff = actual ? Math.abs(actual.amount) - Math.abs(plan.amount) : null;
  const cell: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 };
  const lab: React.CSSProperties = { font: `600 10px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted };
  const val: React.CSSProperties = { font: `600 13px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' };
  const sub: React.CSSProperties = { font: `500 11.5px ${FONT}`, color: C.muted, overflowWrap: 'anywhere' };
  const arrow = <span style={{ color: C.faint, alignSelf: 'center' }}>→</span>;
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start', padding: '8px 10px', borderRadius: R.lg, background: C.bg }}>
      <span style={cell}>
        <span style={lab}>Terv</span>
        <span style={val}>{fmt(Math.abs(plan.amount))} Ft</span>
        <span style={sub}>{dot(plan.date)}</span>
      </span>
      {doc && (
        <>
          {arrow}
          <span style={cell}>
            <span style={lab}>Billingo-számla</span>
            <a href="#" onClick={(ev) => (ev.preventDefault(), openBillingoDoc(doc.id))} style={{ ...val, color: C.blueDark }}>
              {doc.number || 'számla'} ↗
            </a>
            <span style={sub}>
              {fmt(doc.gross)} Ft · {doc.payment_status === 'paid' ? `fizetve ${dot(doc.paid_date)}` : `határidő ${dot(doc.due_date)}`}
            </span>
          </span>
        </>
      )}
      {nav && (
        <>
          {arrow}
          <span style={cell}>
            <span style={lab}>NAV-számla</span>
            <span style={val}>{nav.invoice_number}</span>
            <span style={sub}>
              {fmt(Math.abs(nav.gross))} Ft · {dot(nav.issue_date)}
              {nav.partner_tax ? ` · ${nav.partner_tax}` : ''}
            </span>
          </span>
        </>
      )}
      {tx && (
        <>
          {arrow}
          <span style={cell}>
            <span style={lab}>Bank</span>
            <span style={val}>{fmt(Math.abs(tx.amount))} Ft</span>
            <span style={sub}>
              {dot(tx.date)} · {acc?.bank_name || ''} · {tx.partner}
            </span>
          </span>
        </>
      )}
      {arrow}
      <span style={cell}>
        <span style={lab}>Tény</span>
        {actual ? (
          <>
            <span style={val}>{fmt(Math.abs(actual.amount))} Ft</span>
            <span style={sub}>
              {dot(actual.date)} · {actual.source === 'bank' ? 'bankból' : actual.source === 'billingo' ? 'Billingo szerint fizetve' : 'kézzel'}
            </span>
          </>
        ) : (
          <span style={{ ...val, color: C.offer }}>még nincs</span>
        )}
      </span>
      {diff !== null && (
        <span style={{ ...cell, marginLeft: 'auto', alignItems: 'flex-end' }}>
          <span style={lab}>Különbség</span>
          <span style={{ ...val, color: diffColor(sec, diff) }}>{diffText(diff)} Ft</span>
        </span>
      )}
    </div>
  );
}

/** tény azonosító → a hozzá kötött (lezárt) terv */
export function usePlanOfActual(): Map<string, Entry> {
  const { data } = useStore();
  return useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of data.entries) if (e.kind === 'plan' && e.done && e.link_id) m.set(e.link_id, e);
    return m;
  }, [data.entries]);
}

/** „terv 300 000 · eltérés +81 000” – a tény alatti kis sorhoz */
export function PlanDiff({ actual, plan, sec }: { actual: Entry; plan?: Entry; sec: Section | undefined }) {
  if (!plan) return null;
  const diff = Math.abs(actual.amount) - Math.abs(plan.amount);
  return (
    <>
      {' · terv '}
      {fmt(Math.abs(plan.amount))}
      {diff ? <b style={{ color: diffColor(sec, diff) }}> · eltérés {diffText(diff)}</b> : ' · pontosan a terv'}
    </>
  );
}
