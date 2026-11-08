// Számlatörténet: havi lapozás, számlánként nyitó / bejövő / kimenő / záró egyenleg, a hónap tranzakciói kategóriával,
// állapottal és a kapcsolt számlával (Billingo / NAV); készpénz-számla kézi tételekkel.
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fmt, monthLong } from '../../shared/model';
import { api } from './api';
import { MoneyInput } from './PartnerModal';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Modal, Pill, card, inputStyle, R } from './ui';
import { displayGroup } from '../../shared/categories';
import { NavInvoiceModal } from './AlertsView';
import { TxCard } from './TxCard';
import { useFrequentLeaves } from './BankView';
import { normalizeText } from '../../shared/categories';
import type { BankTx } from '../../shared/types';

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
  accounts: Record<string, { open: BankBal | null; inc: number; out: number; close: BankBal | null; n: number }>;
}
/** banki egyenleg-adat: összeg, nap, forrás (aggreg8: a bank jelentette szinkronkor; kivonat: bankszámlakivonat; pénztár: házipénztár) */
export interface BankBal {
  amount: number;
  date: string;
  source: string;
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
  invoices: { kind: 'billingo' | 'nav'; number: string; id?: string | number }[];
  files: { id: string; name: string; mime: string; size: number; drive_link: string | null; created_at: number }[];
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
  const { data, canEdit, isAdmin } = useStore();
  const [ym, setYm] = useState(data.today.slice(0, 7));
  const [account, setAccount] = useState('');
  const [cashOpen, setCashOpen] = useState(false);
  const [openTx, setOpenTx] = useState<LedgerTx | null>(null);
  const { r, err } = useLedger(ym, account);
  const month = r?.months.find((m) => m.ym === ym);
  const accs = r?.accounts || [];
  const shown = account ? accs.filter((a) => a.id === account) : accs;
  // összesen: csak ha minden számlához van banki adat (hiányos adatból nem számolunk)
  const sumBal = (k: 'open' | 'close') =>
    shown.every((a) => month?.accounts[a.id]?.[k]) ? shown.reduce((s, a) => s + month!.accounts[a.id][k]!.amount, 0) : null;
  const tot = {
    open: sumBal('open'),
    close: sumBal('close'),
    inc: shown.reduce((s, a) => s + (month?.accounts[a.id]?.inc || 0), 0),
    out: shown.reduce((s, a) => s + (month?.accounts[a.id]?.out || 0), 0),
  };
  const accName = (id: string) => {
    const a = accs.find((x) => x.id === id);
    return a ? a.bank_name : id;
  };
  const th: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted };
  const COLS = '76px 84px minmax(170px,1.3fr) minmax(120px,1fr) 120px minmax(150px,1fr) minmax(170px,1.1fr) 120px';
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
                  <BalLine l="Nyitó egyenleg" b={x.open} />
                  <Line l="Bejövő" v={'+' + fmt(x.inc)} c={C.inc} />
                  <Line l="Kimenő" v={'−' + fmt(Math.abs(x.out))} c={C.neg} />
                  <BalLine l="Záró egyenleg" b={x.close} bold />
                  {isAdmin && a.provider !== 'cash' && <StatementEntry accountId={a.id} ym={ym} cur={x.close} />}
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
            <Line l="Nyitó egyenleg" v={tot.open === null ? 'nincs teljes banki adat' : fmt(tot.open)} />
            <Line l="Bejövő" v={'+' + fmt(tot.inc)} c={C.inc} />
            <Line l="Kimenő" v={'−' + fmt(Math.abs(tot.out))} c={C.neg} />
            <Line l="Záró egyenleg" v={tot.close === null ? 'nincs teljes banki adat' : fmt(tot.close)} bold />
            {tot.open !== null && tot.close !== null && <Line l="Változás" v={sign(tot.close - tot.open)} c={tot.close - tot.open < 0 ? C.neg : C.inc} />}
          </div>
        )}
      </div>

      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ minWidth: 1180 }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '12px 16px', borderBottom: `1px solid ${C.line}` }}>
            {['Dátum', 'Számla', 'Partner', 'Közlemény', 'Összeg', 'Kategória', 'Kapcsolt számla', 'Feltöltött'].map((h, i) => (
              <span key={h} style={{ ...th, textAlign: i === 4 ? 'right' : 'left' }}>
                {h}
              </span>
            ))}
          </div>
          {r && !r.tx.length && <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Ebben a hónapban nincs tétel.</div>}
          {!r && !err && <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Betöltés…</div>}
          {r?.tx.map((t) => (
            <LedgerRow key={t.id} t={t} accName={accName} cols={COLS} onOpen={() => setOpenTx(t)} />
          ))}
        </div>
      </div>
      {openTx && <TxModal t={r?.tx.find((x) => x.id === openTx.id) || openTx} onClose={() => setOpenTx(null)} />}
      {cashOpen && <CashDialog onClose={() => setCashOpen(false)} opening={r?.cashOpening || 0} />}
    </div>
  );
}

const SRC: Record<string, string> = { aggreg8: 'bank jelentette', kivonat: 'kivonat szerint', pénztár: 'pénztár' };
export const balNote = (b: BankBal) => `${SRC[b.source] || b.source}, ${b.date.replace(/-/g, '.')}.`;

function BalLine({ l, b, bold }: { l: string; b: BankBal | null; bold?: boolean }) {
  return (
    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, font: `${bold ? 700 : 400} 14px ${FONT}`, color: C.ink }}>
      <span style={{ color: C.muted, fontWeight: 400 }}>{l}</span>
      {b ? (
        <span style={{ textAlign: 'right' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(b.amount)}</span>
          <span style={{ display: 'block', font: `400 11.5px ${FONT}`, color: C.muted }}>{balNote(b)}</span>
        </span>
      ) : (
        <span style={{ font: `500 12.5px ${FONT}`, color: C.faint }}>nincs banki adat</span>
      )}
    </span>
  );
}

/** a bankszámlakivonat szerinti záró egyenleg rögzítése a hónapra (admin) */
function StatementEntry({ accountId, ym, cur }: { accountId: string; ym: string; cur: BankBal | null }) {
  const { run } = useStore();
  const [open, setOpen] = useState(false);
  const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [date, setDate] = useState(last);
  const [amount, setAmount] = useState(cur?.source === 'kivonat' ? String(Math.round(cur.amount)) : '');
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', padding: 0, color: C.blueDark, font: `600 12.5px ${FONT}`, cursor: 'pointer' }}
      >
        {cur?.source === 'kivonat' ? 'Kivonat szerinti egyenleg módosítása' : '+ Kivonat szerinti záró egyenleg'}
      </button>
    );
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 8 }}>
      <Field label="Kivonat napja">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, height: 34, width: 140 }} />
      </Field>
      <Field label="Záró egyenleg (Ft)">
        <MoneyInput value={amount} onChange={setAmount} style={{ ...inputStyle, height: 34, width: 140 }} />
      </Field>
      <Pill
        small
        kind="primary"
        onClick={async () => {
          if (
            amount !== '' &&
            (await run(
              () => api('/api/bank/statement', { method: 'PUT', body: { account_id: accountId, date, amount: Number(amount) } }),
              'Kivonat szerinti egyenleg rögzítve',
            ))
          )
            setOpen(false);
        }}
      >
        Mentés
      </Pill>
      <Pill small onClick={() => setOpen(false)}>
        Mégse
      </Pill>
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

/** a hónap egy tétele: partner (adatlap), kategória, kapcsolt számla (megnyitható), feltöltött számla, kattintásra kezelés */
function LedgerRow({ t, accName, cols, onOpen }: { t: LedgerTx; accName: (id: string) => string; cols: string; onOpen: () => void }) {
  const { ix, openPartner, canEdit, run } = useStore();
  const [nav, setNav] = useState<string | null>(null);
  const [st, sc] = STATUS[t.status] || [t.status, C.muted];
  const leaf = t.leaf_id ? ix.leafById[t.leaf_id] : null;
  const grp = leaf ? displayGroup(ix.groupById[leaf.group_id]?.label || '') : '';
  const openBillingo = async (id: string | number) => {
    try {
      const r = await api<{ url: string }>(`/api/billingo/doc/${id}/url`);
      window.open(r.url, '_blank', 'noopener');
    } catch (e: any) {
      alert(e.message);
    }
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return alert('Legfeljebb 10 MB-os fájl tölthető fel.');
    const rd = new FileReader();
    rd.onload = () => {
      const b64 = String(rd.result).split(',')[1] || '';
      run(
        () => api(`/api/bank/tx/${encodeURIComponent(t.id)}/file`, { body: { name: f.name, mime: f.type || 'application/pdf', data: b64 } }),
        `Számla feltöltve: ${f.name}`,
      );
    };
    rd.readAsDataURL(f);
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      className="hov-row"
      title="Kattints a tétel kezeléséhez (kategória, párosítás, ütemezés, jóváhagyás)"
      style={{
        display: 'grid',
        gridTemplateColumns: cols,
        gap: 10,
        padding: '10px 16px',
        borderTop: `1px solid ${C.line3}`,
        alignItems: 'center',
        font: `400 13.5px ${FONT}`,
        color: C.ink,
        cursor: 'pointer',
      }}
    >
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t.date.slice(5).replace('-', '.')}.</span>
      <span style={{ color: C.muted }}>{accName(t.account_id)}</span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {leaf ? (
          <button
            type="button"
            className="partner-link"
            onClick={(e) => (stop(e), openPartner(leaf.id))}
            style={{
              border: 0,
              background: 'transparent',
              padding: 0,
              textAlign: 'left',
              font: `600 13.5px ${FONT}`,
              color: C.blueDark,
              cursor: 'pointer',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {leaf.label}
          </button>
        ) : (
          <b style={{ color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.partner || '–'}</b>
        )}
        {leaf && t.partner && (
          <span style={{ font: `400 11.5px ${FONT}`, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.partner}</span>
        )}
      </span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.muted }} title={t.memo}>
        {t.memo || '–'}
      </span>
      <b style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: t.amount < 0 ? C.neg : C.inc }}>{sign(t.amount)}</b>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{leaf ? `${grp} › ${leaf.label}` : 'nincs kategória'}</span>
        <span style={{ font: `500 11.5px ${FONT}`, color: sc }}>{st}</span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {t.invoices.length ? (
          t.invoices.map((iv) => (
            <button
              key={iv.number}
              type="button"
              onClick={(e) => (stop(e), iv.kind === 'nav' ? setNav(iv.number) : iv.id !== undefined && openBillingo(iv.id))}
              style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', font: `600 12.5px ${FONT}`, color: C.blueDark, cursor: 'pointer' }}
              title={iv.kind === 'nav' ? 'Bejövő számla (NAV) megnyitása' : 'Kimenő számla (Billingo) megnyitása'}
            >
              {iv.kind === 'nav' ? 'NAV' : 'Billingo'}: {iv.number} ↗
            </button>
          ))
        ) : (
          <span style={{ font: `500 12.5px ${FONT}`, color: C.faint }}>nincs számla kapcsolva</span>
        )}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }} onClick={stop}>
        {t.files.map((f) => (
          <a
            key={f.id}
            href={`api/bank/file/${encodeURIComponent(f.id)}`}
            target="_blank"
            rel="noreferrer"
            style={{ font: `600 12px ${FONT}`, color: C.inc }}
            title={f.name}
          >
            ✓ számla{f.drive_link ? ' · Drive' : ''}
          </a>
        ))}
        {canEdit && (
          <label style={{ font: `600 12px ${FONT}`, color: C.blueDark, cursor: 'pointer' }}>
            + feltöltés
            <input type="file" accept="application/pdf,image/*,.xml" hidden onChange={(e) => upload(e.target.files?.[0])} />
          </label>
        )}
      </span>
      {nav && (
        <span onClick={stop}>
          <NavInvoiceModal number={nav} onClose={() => setNav(null)} />
        </span>
      )}
    </div>
  );
}

/** a tétel kezelése felugró ablakban: várakozónál a teljes kezelő (kategória, párosítás, ütemezés, jóváhagyás), lezártnál visszavonás */
function TxModal({ t, onClose }: { t: LedgerTx; onClose: () => void }) {
  const { ix, run, canEdit } = useStore();
  const [freqIn, freqOut] = useFrequentLeaves();
  const unforeseen = ix.leaves.find((l) => !l.archived && ix.sectionOf(l.id) === 'out' && normalizeText(l.label).startsWith('elore nem lathato'))?.id ?? null;
  const bt: BankTx = {
    id: t.id,
    account_id: t.account_id,
    date: t.date,
    amount: t.amount,
    currency: 'HUF',
    partner: t.partner,
    memo: t.memo,
    status: t.status as BankTx['status'],
    leaf_id: t.leaf_id,
    plan_id: t.plan_id,
    actual_id: t.actual_id,
  };
  const leaf = t.leaf_id ? ix.leafById[t.leaf_id] : null;
  return (
    <Modal onClose={onClose} width={980} title={`${t.partner || 'Tétel'} · ${sign(t.amount)} Ft · ${t.date.replace(/-/g, '.')}.`} label="Banki tétel kezelése">
      <div style={{ padding: '4px 24px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {t.status === 'new' ? (
          <TxCard t={bt} frequent={t.amount >= 0 ? freqIn : freqOut} unforeseen={unforeseen} open />
        ) : (
          <>
            <span style={{ font: `400 14px/1.6 ${FONT}`, color: C.ink }}>
              Állapot: <b>{t.status === 'approved' ? 'jóváhagyva' : 'kihagyva'}</b>
              {leaf ? (
                <>
                  {' '}
                  · kategória: <b>{leaf.label}</b>
                </>
              ) : null}
              {t.memo ? <> · {t.memo}</> : null}
            </span>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8 }}>
                <Pill
                  kind="primary"
                  onClick={() =>
                    run(
                      () =>
                        t.status === 'approved'
                          ? api('/api/bank/unapprove', { body: { ids: [t.id] } })
                          : api('/api/bank/ignore', { body: { ids: [t.id], undo: true } }),
                      t.status === 'approved' ? 'Jóváhagyás visszavonva – most módosíthatod' : 'Visszavéve a várakozó tételek közé',
                    )
                  }
                >
                  {t.status === 'approved' ? 'Jóváhagyás visszavonása és módosítás' : 'Visszavétel a jóváhagyandók közé'}
                </Pill>
                <Pill onClick={onClose}>Bezár</Pill>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
