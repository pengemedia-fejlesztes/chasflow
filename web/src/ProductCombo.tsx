// Megnevezés-mező kereső legördülővel a termék- és szolgáltatástörzsből: gépelésre szűr, a kiválasztott tétel
// hozza a nevet, az árat (a partner egyedi árát, ha van) és mutatja az elérhető darabszámot.
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { BILLING_LABEL, effective, grossOf, type PartnerProduct, type Product } from '../../shared/catalog';
import { normalizeText } from '../../shared/categories';
import { fmt } from '../../shared/model';
import { useStore } from './store';
import { availOf, useInventory } from './StockView';
import { C, FONT, R, SHADOW } from './ui';

export interface ComboPick {
  product: Product;
  /** a partnerhez rendelt sor (ha van) */
  assign: PartnerProduct | null;
  /** nettó egységár (a partner egyedi ára, ha van) */
  net: number;
  /** bruttó összeg (mennyiség × egységár + ÁFA) */
  gross: number;
  qty: number;
}

export function ProductCombo({
  value,
  onChange,
  onPick,
  partnerKey,
  placeholder,
  style,
  autoFocus,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (p: ComboPick) => void;
  partnerKey?: string | null;
  placeholder?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  label?: string;
}) {
  const { data } = useStore();
  const products = data.products || [];
  const assigns = data.partnerProducts || [];
  const inv = useInventory();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  // Enter csak akkor választ a listából, ha nyilakkal léptek rá – különben a beírt név marad (nem írjuk felül)
  const [nav, setNav] = useState(false);
  const blurT = useRef<number | null>(null);
  const nq = normalizeText(value);
  const list = useMemo(() => {
    const mine = new Set(assigns.filter((a) => a.partner_key === partnerKey).map((a) => a.product_id));
    return products
      .filter((p) => !p.archived)
      .filter((p) => !nq || normalizeText(`${p.name} ${p.sku || ''}`).includes(nq))
      .sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)) || a.name.localeCompare(b.name, 'hu'))
      .slice(0, 12)
      .map((p) => {
        const a = assigns.find((x) => x.partner_key === partnerKey && x.product_id === p.id) || null;
        const e = a ? effective(a, p) : { price: p.price, net: p.price, gross: grossOf(p.price, p.vat), billing: p.billing };
        return { p, a, e, avail: availOf(inv, p.id) };
      });
  }, [products, assigns, nq, partnerKey, inv]);
  const pick = (i: number) => {
    const x = list[i];
    if (!x) return;
    const qty = x.a?.qty || 1;
    onPick({ product: x.p, assign: x.a, net: x.e.price, gross: x.e.gross, qty });
    setOpen(false);
  };
  const exact = list.some((x) => normalizeText(x.p.name) === nq);
  const id = useRef('pc-' + Math.random().toString(36).slice(2, 8)).current;
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        role="combobox"
        aria-label={label || 'Megnevezés'}
        aria-expanded={open && list.length > 0}
        aria-controls={id}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(0);
          setNav(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => (blurT.current = window.setTimeout(() => setOpen(false), 150))}
        onKeyDown={(e) => {
          if (!open || !list.length) return;
          if (e.key === 'ArrowDown') (e.preventDefault(), setNav(true), setHi((hi + 1) % list.length));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setNav(true), setHi((hi - 1 + list.length) % list.length));
          else if (e.key === 'Enter' && !exact && nav) (e.preventDefault(), e.stopPropagation(), pick(hi));
          else if (e.key === 'Enter') setOpen(false);
          else if (e.key === 'Escape') setOpen(false);
        }}
        style={{ width: '100%', boxSizing: 'border-box', ...style }}
      />
      {open && list.length > 0 && (
        <div
          id={id}
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'absolute',
            zIndex: 30,
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: '#fff',
            border: `1px solid ${C.line}`,
            borderRadius: R.lg,
            boxShadow: SHADOW.pop,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <div style={{ padding: '8px 14px 4px', font: `600 11px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted }}>
            Termékek, szolgáltatások
          </div>
          {list.map((x, i) => (
            <div
              key={x.p.id}
              role="option"
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 14px',
                cursor: 'pointer',
                background: i === hi ? C.bg2 : '#fff',
                borderTop: `1px solid ${C.line3}`,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <b style={{ font: `600 14.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.p.name}</b>
                <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                  {BILLING_LABEL[x.e.billing]}
                  {x.a ? ' · ennél a partnernél' + (x.a.price !== null ? ' egyedi áron' : '') : ''}
                  {x.p.sku ? ` · ${x.p.sku}` : ''}
                </span>
              </span>
              <span style={{ textAlign: 'right', display: 'flex', flexDirection: 'column' }}>
                <b style={{ font: `600 14px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(x.e.price)} {x.p.currency === 'HUF' ? 'Ft' : x.p.currency}
                  <span style={{ font: `400 12px ${FONT}`, color: C.muted }}> nettó/{x.p.unit}</span>
                </b>
                <span style={{ font: `500 12px ${FONT}`, color: x.avail === null ? C.faint : x.avail > 0 ? C.inc : C.neg }}>
                  {x.avail === null ? 'nincs készletkezelés' : `elérhető: ${fmt(x.avail)} ${x.p.unit}`}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
