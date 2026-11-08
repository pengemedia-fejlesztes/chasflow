// Számlatörténet: havi lapozás, számlánként nyitó / bejövő / kimenő / záró egyenleg, a hónap tranzakciói kategóriával,
// állapottal és a kapcsolt számlával (Billingo / NAV); készpénz-számla kézi tételekkel.
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fmt, monthLong } from '../../shared/model';
import { api } from './api';
import { MoneyInput } from './PartnerModal';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Pill, card, inputStyle, R } from './ui';

export interface LedgerAcc {
  id: string;
  provider: string;
  bank_name: string;
  label: string;
  iban: string | null;
  balance: number | null;
}
export interface LedgerMonthRow {
  ym: string;
  accounts: Record<string, { open: number; inc: number; out: number; close: number; n: number }>;
}
interface LedgerTx {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  partner: string;
  memo: string;
  status: string;
  leaf_id: string | null;
  plan_id: string | null;
  actual_id: string | null;
  invoices: { kind: 'billingo' | 'nav'; number: string }[];
}
interface LedgerResp {
  ym: string;
  prev: string;
  next: string;
  accounts: LedgerAcc[];
  months: LedgerMonthRow[];
  tx: LedgerTx[];
  cashOpening: number;
}

const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
const STATUS: Record<string, [string, string]> = { new: ['jóváhagyásra vár', C.offer], approved: ['jóváhagyva', C.inc], ignored: ['kihagyva', C.faint] };

/** a havi banki összesítő betöltése (a Fedezeti pont is használja) */
export function useLedger(ym: string, account: string) {
  const { data } = useStore();
  const [r, setR] = useState<LedgerResp | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api<LedgerResp>(`/api/bank/ledger?ym=${ym}${account ? '&account=' + encodeURIComponent(account) : ''}`).then(
      (x) => (setR(x), setErr('')),
      (e) => setErr(e.message),
    );
  }, [ym, account]);
  // a betöltött adatok változásakor (pl. jóváhagyás, új tétel) újratöltjük
  useEffect(load, [load, data]);
  return { r, err, reload: load };
}

export function LedgerView() {
  const { data, ix, canEdit } = useStore();
  const [ym, setYm] = useState(data.today.slice(0, 7));
  const [account, setAccount] = useState('');
  const [cashOpen, setCashOpen] = useState(false);
  const { r, err } = useLedger(ym, account);
  const month = r?.months.find((m) => m.ym === ym);
  const accs = r?.accounts || [];
  const shown = account ? accs.filter((a) => a.id === account) : accs;
  const tot = shown.reduce(
    (s, a) => {
      const x = month?.accounts[a.id];
      return x ? { open: s.open + x.open, inc: s.inc + x.inc, out: s.out + x.out, close: s.close + x.close } : s;
    },
    { open: 0, inc: 0, out: 0, close: 0 },
  );
  const accName = (id: string) => {
    const a = accs.find((x) => x.id === id);
    return a ? a.bank_name : id;
  };
  const th: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted };
  const COLS = '92px 110px minmax(160px,1.3fr) minmax(140px,1fr) 130px minmax(120px,0.8fr) minmax(130px,0.9fr)';
  return (
    <div style={{ padding: '20px 28px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Pill small onClick={() => r && setYm(r.prev)}>
          ‹ előző
        </Pill>
        <b style={{ font: `700 22px ${FONT_H}`, color: C.navy, minWidth: 180, textAlign: 'center' }}>{monthLong(ym)}</b>
        <Pill small onClick={() => r && ym < data.today.slice(0, 7) && setYm(r.next)}>
          következő ›
        </Pill>
        {ym !== data.today.slice(0, 7) && (
          <Pill small onClick={() => setYm(data.today.slice(0, 7))}>
            Ez a hónap
          </Pill>
        )}
        <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Számla" style={{ ...inputStyle, height: 38, width: 220 }}>
          <option value="">Minden számla</option>
          {accs.map((a) => (
            <option key={a.id} value={a.id}>
              {a.bank_name} · {a.label}
            </option>
          ))}
        </select>
        {canEdit && (
          <button
            type="button"
            onClick={() => setCashOpen(true)}
            style={{
              marginLeft: 'auto',
              border: 0,
              borderRadius: 999,
              background: C.blue,
              color: '#fff',
              padding: '10px 18px',
              font: `600 14px ${FONT}`,
              cursor: 'pointer',
            }}
          >
            + Készpénzes tétel
          </button>
        )}
      </div>
      {err && <div style={{ ...card, padding: 14, color: C.neg, font: `500 14px ${FONT}` }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(240px, 1fr))`, gap: 12 }}>
        {shown.map((a) => {
          const x = month?.accounts[a.id];
          return (
            <div key={a.id} style={{ ...card, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <b style={{ font: `700 15px ${FONT}`, color: C.navy }}>
                {a.bank_name} <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>· {a.label}</span>
              </b>
              {x ? (
                <>
                  <Line l="Nyitó egyenleg" v={fmt(x.open)} />
                  <Line l="Bejövő" v={'+' + fmt(x.inc)} c={C.inc} />
                  <Line l="Kimenő" v={'−' + fmt(Math.abs(x.out))} c={C.neg} />
                  <Line l="Záró egyenleg" v={fmt(x.close)} bold />
                  <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>{x.n} tétel</span>
                </>
              ) : (
                <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>Nincs adat erre a hónapra.</span>
              )}
            </div>
          );
        })}
        {shown.length > 1 && (
          <div style={{ ...card, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, background: C.bg2 }}>
            <b style={{ font: `700 15px ${FONT}`, color: C.navy }}>Összesen</b>
            <Line l="Nyitó egyenleg" v={fmt(tot.open)} />
            <Line l="Bejövő" v={'+' + fmt(tot.inc)} c={C.inc} />
            <Line l="Kimenő" v={'−' + fmt(Math.abs(tot.out))} c={C.neg} />
            <Line l="Záró egyenleg" v={fmt(tot.close)} bold />
            <Line l="Változás" v={sign(tot.close - tot.open)} c={tot.close - tot.open < 0 ? C.neg : C.inc} />
          </div>
        )}
      </div>

      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ minWidth: 980 }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '12px 16px', borderBottom: `1px solid ${C.line}` }}>
            {['Dátum', 'Számla', 'Partner', 'Közlemény', 'Összeg', 'Kategória', 'Kapcsolt számla'].map((h, i) => (
              <span key={h} style={{ ...th, textAlign: i === 4 ? 'right' : 'left' }}>
                {h}
              </span>
            ))}
          </div>
          {r && !r.tx.length && <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Ebben a hónapban nincs tétel.</div>}
          {!r && !err && <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Betöltés…</div>}
          {r?.tx.map((t) => {
            const [sl, sc] = STATUS[t.status] || [t.status, C.muted];
            return (
              <div
                key={t.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COLS,
                  gap: 10,
                  padding: '10px 16px',
                  borderTop: `1px solid ${C.line3}`,
                  alignItems: 'center',
                  font: `400 13.5px ${FONT}`,
                  color: C.ink,
                }}
              >
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t.date.slice(5).replace('-', '.')}.</span>
                <span style={{ color: C.muted }}>{accName(t.account_id)}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: C.navy }}>
                  {t.partner || '–'}
                </span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.muted }} title={t.memo}>
                  {t.memo || '–'}
                </span>
                <b style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: t.amount < 0 ? C.neg : C.inc }}>{sign(t.amount)}</b>
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.leaf_id ? ix.leafById[t.leaf_id]?.label || '–' : '–'}
                  </span>
                  <span style={{ font: `500 11.5px ${FONT}`, color: sc }}>{sl}</span>
                </span>
                <span style={{ font: `500 12.5px ${FONT}`, color: t.invoices.length ? C.blueDark : C.faint }}>
                  {t.invoices.length ? t.invoices.map((i) => `${i.kind === 'nav' ? 'NAV' : 'Billingo'}: ${i.number}`).join(', ') : 'nincs számla kapcsolva'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {cashOpen && <CashDialog onClose={() => setCashOpen(false)} opening={r?.cashOpening || 0} />}
    </div>
  );
}

function Line({ l, v, c, bold }: { l: string; v: string; c?: string; bold?: boolean }) {
  return (
    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, font: `${bold ? 700 : 400} 14px ${FONT}`, color: c || C.ink }}>
      <span style={{ color: C.muted, fontWeight: 400 }}>{l}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </span>
  );
}

function CashDialog({ onClose, opening }: { onClose: () => void; opening: number }) {
  const { data, run, isAdmin } = useStore();
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [date, setDate] = useState(data.today);
  const [amount, setAmount] = useState('');
  const [partner, setPartner] = useState('');
  const [memo, setMemo] = useState('');
  const [open, setOpen] = useState(String(opening || ''));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy || !amount) return;
    setBusy(true);
    const ok = await run(
      () => api('/api/bank/cash', { body: { date, amount: (dir === 'out' ? -1 : 1) * Number(amount), partner, memo } }),
      'Készpénzes tétel felvéve – a Beérkezett tételek között kategorizálhatod',
    );
    setBusy(false);
    if (ok) onClose();
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  return (
    <div
      role="dialog"
      aria-label="Készpénzes tétel"
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,35,58,.35)', display: 'grid', placeItems: 'center', zIndex: 50 }}
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => (e.preventDefault(), save())}
        style={{ ...card, width: 'min(520px, 94vw)', padding: 24, display: 'flex', flexDirection: 'column', gap: 12, borderRadius: R.lg }}
      >
        <b style={{ font: `700 20px ${FONT_H}`, color: C.navy }}>Készpénzes tétel</b>
        <div style={{ display: 'flex', gap: 6 }}>
          <Pill small kind={dir === 'out' ? 'primary' : 'light'} onClick={() => setDir('out')}>
            Kiadás (fizettem)
          </Pill>
          <Pill small kind={dir === 'in' ? 'primary' : 'light'} onClick={() => setDir('in')}>
            Bevétel / befizetés
          </Pill>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Dátum">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required style={sel} />
          </Field>
          <Field label="Összeg (Ft)">
            <MoneyInput value={amount} onChange={setAmount} autoFocus required style={sel} />
          </Field>
        </div>
        <Field label="Kinek / kitől">
          <input value={partner} onChange={(e) => setPartner(e.target.value)} maxLength={120} placeholder="pl. OMV, posta, piac" style={sel} />
        </Field>
        <Field label="Megjegyzés">
          <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={300} placeholder="pl. tankolás, bélyeg, nyugta száma" style={sel} />
        </Field>
        <span style={{ font: `400 12.5px/1.5 ${FONT}`, color: C.muted }}>
          A tétel a Bankszinkron „Beérkezett tételek” közé kerül, ott kategorizálod és párosítod, ahogy a banki tételeket.
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="submit"
            disabled={busy || !amount}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '10px 22px', font: `600 14px ${FONT}`, cursor: 'pointer' }}
          >
            Felvétel
          </button>
          <Pill small onClick={onClose}>
            Mégse
          </Pill>
        </div>
        {isAdmin && (
          <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <Field label="Készpénz nyitó egyenlege (a házipénztár induló összege)" style={{ flex: 1 }}>
              <MoneyInput value={open} onChange={setOpen} style={sel} />
            </Field>
            <Pill
              small
              onClick={() => run(() => api('/api/bank/cash/opening', { method: 'PUT', body: { amount: Number(open || 0) } }), 'Nyitó egyenleg mentve')}
            >
              Mentés
            </Pill>
          </div>
        )}
      </form>
    </div>
  );
}
