// Összevonás fülek: kiállított számla terv nélkül (hova sorolta a rendszer), be nem azonosított banki tételek,
// és a partnernevek összevonása (partnertörzs alternatív nevei = NAV / Billingo cégnév = elszámolás projektneve = banki név).
import { useMemo, useState } from 'react';
import { normalizeText } from '../../shared/categories';
import { compactName, partnerResolver, suggestPartner } from '../../shared/identity';
import { fmt, monthLong, ymOf } from '../../shared/model';
import { isInternalProject } from '../../shared/worktime';
import type { Entry } from '../../shared/types';
import { api } from './api';
import { useFrequentLeaves } from './BankView';
import { LeafPicker } from './LeafPicker';
import { useStore } from './store';
import { TxCard } from './TxCard';
import { C, FONT, FONT_H, Pill, card } from './ui';

const dot = (d: string) => d.replace(/-/g, '.') + '.';

function useAck(): [Set<string>, (ids: string[], msg: string) => Promise<unknown>] {
  const { data, run } = useStore();
  const set = useMemo(() => {
    try {
      return new Set<string>(JSON.parse(data.settings.flags_ack || '[]'));
    } catch {
      return new Set<string>();
    }
  }, [data.settings.flags_ack]);
  const ack = (ids: string[], msg: string) =>
    run(
      () => api('/api/flags/ack', { body: { ids } }),
      msg,
      () => api('/api/flags/ack', { body: { ids, undo: true } }),
    );
  return [set, ack];
}

/** Billingo-számla, amihez nem volt terv: a rendszer maga sorolta be (a partner bevételi alkategóriájába). */
function useBillingoUnplanned(): Entry[] {
  const { data } = useStore();
  const [acked] = useAck();
  return useMemo(() => {
    const since = new Date(Date.parse(data.today) - 120 * 86400000).toISOString().slice(0, 10);
    const docs = new Map(data.billingo.filter((d) => d.plan_id).map((d) => [d.plan_id as string, d]));
    return data.entries
      .filter(
        (e) =>
          e.kind === 'plan' &&
          e.source === 'billingo' &&
          /^b\d+$/.test(e.id) &&
          e.plan_amount == null &&
          !acked.has(`bnp:${e.id}`) &&
          (docs.get(e.id)?.invoice_date || e.date) >= since,
      )
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data.entries, data.billingo, data.today, acked]);
}

/** banki tétel, amihez a rendszer nem talált tervet / számlát */
function useBankUnmatched() {
  const { data } = useStore();
  return useMemo(() => data.bankTx.filter((t) => t.status === 'new' && !t.plan_id).sort((a, b) => b.date.localeCompare(a.date)), [data.bankTx]);
}

interface NameRow {
  c: string;
  name: string;
  tax: string | null;
  src: Record<string, { n: number; amount: number }>;
}

function useNameRows() {
  const { data, ix } = useStore();
  const [acked] = useAck();
  return useMemo(() => {
    const r = partnerResolver(ix.leaves, data.partners || []);
    const rows = new Map<string, NameRow>();
    const add = (name: string | null | undefined, tax: string | null | undefined, src: string, amount: number) => {
      const n = String(name || '')
        .replace(/\s+/g, ' ')
        .trim();
      const c = compactName(n);
      if (c.length < 3) return;
      const row = rows.get(c) || rows.set(c, { c, name: n, tax: null, src: {} }).get(c)!;
      if (tax && !row.tax) row.tax = tax;
      const s = row.src[src] || (row.src[src] = { n: 0, amount: 0 });
      s.n++;
      s.amount += amount;
    };
    (data.navInvoices || []).forEach((n) => add(n.partner_name, n.partner_tax, 'NAV', Math.abs(n.gross)));
    data.billingo.forEach((d) => !d.cancelled && add(d.partner, d.partner_tax, 'Billingo', Math.abs(d.gross)));
    (data.worktime || []).forEach((w) => !isInternalProject(w.project) && add(w.project, null, 'Elszámolás', 0));
    data.bankTx.forEach((t) => t.status === 'new' && !t.leaf_id && add(t.partner, null, 'Bank', Math.abs(t.amount)));
    const open: (NameRow & { sug: ReturnType<typeof suggestPartner> })[] = [];
    const merged = new Map<string, { name: string; names: NameRow[] }>();
    for (const row of rows.values()) {
      const hit = r.resolve(row.name, row.tax);
      if (!hit) {
        if (!acked.has(`name:${row.c}`)) open.push({ ...row, sug: suggestPartner(r, row.name) });
        continue;
      }
      if (row.c === hit.key || row.c === compactName(hit.name)) continue;
      const m = merged.get(hit.key) || merged.set(hit.key, { name: hit.name, names: [] }).get(hit.key)!;
      m.names.push(row);
    }
    const total = (x: NameRow) => Object.values(x.src).reduce((a, s) => a + s.amount, 0);
    return {
      resolver: r,
      open: open.sort((a, b) => Number(!!b.sug) - Number(!!a.sug) || total(b) - total(a)),
      merged: [...merged.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'hu')),
    };
  }, [data.navInvoices, data.billingo, data.worktime, data.bankTx, data.partners, ix.leaves, acked]);
}

/** a fülek számlálói (a menüben és a fül fejlécében) */
export function useMergeCounts() {
  const billingo = useBillingoUnplanned().length;
  const bank = useBankUnmatched().length;
  const names = useNameRows().open.length;
  return { billingo, bank, names };
}

export function MergeBillingo() {
  const { data, ix, canEdit, commit } = useStore();
  const [, ack] = useAck();
  const rows = useBillingoUnplanned();
  const [pick, setPick] = useState<string | null>(null);
  const docs = useMemo(() => new Map(data.billingo.filter((d) => d.plan_id).map((d) => [d.plan_id as string, d])), [data.billingo]);
  if (!rows.length) return null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>
          Kiállított számla, nincs rá terv <span style={{ color: C.neg }}>({rows.length})</span>
        </span>
        <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, flex: 1 }}>
          A Billingo-számlához nem találtunk tervet, ezért a rendszer a partner bevételi kategóriájába sorolta. Ellenőrizd, jó helyre került-e.
        </span>
        {canEdit && rows.length > 1 && (
          <Pill
            small
            onClick={() =>
              ack(
                rows.map((e) => `bnp:${e.id}`),
                `${rows.length} számla rendben`,
              )
            }
          >
            Mind rendben
          </Pill>
        )}
      </div>
      {rows.map((e) => {
        const d = docs.get(e.id);
        const leaf = ix.leafById[e.leaf_id];
        return (
          <div key={e.id} style={{ ...card, borderLeft: `4px solid ${C.blue2}`, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ font: `600 14px ${FONT}`, color: C.ink }}>{d?.partner || e.name}</span>
                <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                  {d?.number || ''} · kelt {dot(d?.invoice_date || e.date)} · határidő {dot(e.date)}
                  {e.done ? ' · fizetve' : ''}
                </span>
                <span style={{ font: `600 12.5px ${FONT}`, color: C.blueDark }}>
                  → {leaf?.label || 'ismeretlen kategória'} · {ix.groupById[leaf?.group_id || '']?.label || ''} · {monthLong(ymOf(e.date))}
                </span>
              </span>
              <b style={{ font: `700 14px ${FONT}`, color: '#1A7340', fontVariantNumeric: 'tabular-nums' }}>{fmt(e.bill_amount ?? e.amount)} Ft</b>
              {canEdit && (
                <>
                  <Pill small onClick={() => setPick(pick === e.id ? null : e.id)}>
                    {pick === e.id ? 'Mégse' : 'Máshova sorolom'}
                  </Pill>
                  <Pill small onClick={() => ack([`bnp:${e.id}`], 'Rendben')}>
                    Jó helyen van
                  </Pill>
                </>
              )}
            </div>
            {pick === e.id && (
              <LeafPicker
                section="in"
                value={e.leaf_id}
                onChange={async (id) => {
                  setPick(null);
                  if (id === e.leaf_id) return;
                  const ok = await commit({ upsert: [{ ...e, leaf_id: id }] }, `${d?.partner || e.name} → ${ix.leafById[id]?.label}`);
                  if (ok) await ack([`bnp:${e.id}`], 'Áthelyezve');
                }}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

export function MergeBank({ mobile }: { mobile?: boolean }) {
  const { ix } = useStore();
  const rows = useBankUnmatched();
  const [freqIn, freqOut] = useFrequentLeaves();
  const unforeseen = ix.leaves.find((l) => !l.archived && ix.sectionOf(l.id) === 'out' && normalizeText(l.label).startsWith('elore nem lathato'))?.id ?? null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Beérkezett banki tételek, amelyekhez a rendszer nem talált tervet, illetve a partner számláját (nincs számlaszám a közleményben, és nincs hasonló
        összegű nyitott terv). Válaszd ki a kategóriát és a tervet – a következő hasonló tételt már felismeri.
      </span>
      {!rows.length && <div style={{ ...card, padding: '22px 20px', font: `600 14px ${FONT}`, color: C.blueDark }}>✓ Minden banki tétel azonosítva.</div>}
      {rows.map((t) => (
        <TxCard key={t.id} t={t} frequent={t.amount >= 0 ? freqIn : freqOut} unforeseen={unforeseen} mobile={mobile} />
      ))}
    </section>
  );
}

export function MergeNames() {
  const { data, canEdit, run, openPartner } = useStore();
  const [, ack] = useAck();
  const { resolver, open, merged } = useNameRows();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const merge = (name: string, key: string) => {
    const cur = (data.partners || []).find((p) => p.key === key)?.aliases || [];
    const label = resolver.partners.find((p) => p.key === key)?.name || key;
    return run(
      () => api(`/api/partners/${encodeURIComponent(key)}`, { method: 'PUT', body: { aliases: [...cur, name] } }),
      `„${name}” → ${label}`,
      () => api(`/api/partners/${encodeURIComponent(key)}`, { method: 'PUT', body: { aliases: cur } }),
    );
  };
  const srcLine = (r: NameRow) =>
    Object.entries(r.src)
      .map(([k, s]) => `${k} ${s.n}×${s.amount ? ' · ' + fmt(s.amount) + ' Ft' : ''}`)
      .join(' · ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Egy partner több néven is szerepelhet: a partnertörzs neve és alternatív nevei, a NAV- és a Billingo-számla cégneve, a munkaidő-elszámolás projektneve
        és a banki név. Az azonos adószámú neveket a rendszer magától összevonja; amit nem tud biztosan, azt itt egy kattintással a partnerhez rendelheted
        (alternatív név lesz, a következő számla, banki tétel és elszámolás már ide kerül).
      </span>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>
          Nem azonosított nevek <span style={{ color: open.length ? C.neg : C.muted }}>({open.length})</span>
        </span>
        {!open.length && (
          <div style={{ ...card, padding: '18px 20px', font: `600 14px ${FONT}`, color: C.blueDark }}>✓ Minden név egy partnerhez tartozik.</div>
        )}
        {open.map((r) => {
          const sel = choice[r.c] ?? r.sug?.key ?? '';
          return (
            <div key={r.c} style={{ ...card, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ font: `600 14px ${FONT}`, color: C.ink }}>{r.name}</span>
                <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                  {srcLine(r)}
                  {r.tax ? ` · adószám ${r.tax}` : ''}
                </span>
                {r.sug && <span style={{ font: `600 12.5px ${FONT}`, color: C.blueDark }}>Javaslat: {r.sug.name}</span>}
              </span>
              {canEdit && (
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={sel}
                    onChange={(ev) => setChoice({ ...choice, [r.c]: ev.target.value })}
                    style={{
                      height: 34,
                      maxWidth: 220,
                      borderRadius: 10,
                      border: `1.5px solid ${C.line2}`,
                      padding: '0 8px',
                      font: `500 13px ${FONT}`,
                      color: C.ink,
                    }}
                  >
                    <option value="">– melyik partner? –</option>
                    {resolver.partners.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Pill small kind={sel ? 'primary' : undefined} onClick={() => sel && merge(r.name, sel)}>
                    Összevonás
                  </Pill>
                  <Pill small onClick={() => ack([`name:${r.c}`], `„${r.name}”: nem tartozik meglévő partnerhez`)}>
                    Önálló
                  </Pill>
                </span>
              )}
            </div>
          );
        })}
      </section>
      {merged.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>
            Összevont nevek <span style={{ color: C.muted }}>({merged.length} partner)</span>
          </span>
          {merged.map(([key, m]) => (
            <div key={key} style={{ ...card, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <a
                href="#"
                onClick={(ev) => {
                  ev.preventDefault();
                  openPartner(key);
                }}
                style={{ font: `700 14px ${FONT}`, color: C.blueDark, textDecoration: 'none' }}
              >
                {m.name} ↗
              </a>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {m.names.map((n) => (
                  <span
                    key={n.c}
                    title={srcLine(n)}
                    style={{ padding: '3px 9px', borderRadius: 999, background: C.bg2, color: C.ink, font: `500 12px ${FONT}` }}
                  >
                    {n.name} <span style={{ color: C.muted }}>· {Object.keys(n.src).join(', ')}</span>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
