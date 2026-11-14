// Partner adatlap · „Szolgáltatások és számlázás”: a partner számlázási adatai (cím, e-mail, kapcsolattartó, fizetési
// határidő) és a neki számlázandó termékek / szolgáltatások (mennyiség, egyedi ár, ütem, kezdő és záró hónap).
import { useState } from 'react';
import { BILLING_LABEL, PROFILE_FIELDS, billablesFor, effective, emptyProfile, type PartnerProfile } from '../../shared/catalog';
import { fmt, monthLong } from '../../shared/model';
import type { PartnerStat } from '../../shared/partners';
import { api } from './api';
import { useStore } from './store';
import { PartnerServices } from './ServiceCards';
import { C, FONT, FONT_H, Field, Pill, card, eyebrow, inputStyle, R } from './ui';

export { PartnerServices };

export const money = (v: number, cur = 'HUF') => `${fmt(v)} ${cur === 'HUF' ? 'Ft' : cur}`;

/** Szolgáltatások + számlázási adatok egy partnernek (adatlap fül és partnertörzs panel) */
export function PartnerBillingTab({ p, compact }: { p: PartnerStat; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PartnerServices p={p} compact={compact} />
      <PartnerProfileForm key={p.key} p={p} compact={compact} />
    </div>
  );
}

export function PartnerProfileForm({ p, compact }: { p: PartnerStat; compact?: boolean }) {
  const { data, run, canEdit } = useStore();
  const saved: PartnerProfile = data.partnerProfiles?.[p.key] || emptyProfile();
  const [v, setV] = useState<PartnerProfile>(saved);
  const save = (over: Partial<PartnerProfile> = {}) => {
    const next = { ...v, ...over };
    if (!canEdit || JSON.stringify(next) === JSON.stringify(saved)) return;
    run(() => api(`/api/partner-profile/${encodeURIComponent(p.key)}`, { method: 'PUT', body: next }), `${p.name}: számlázási adatok mentve`);
  };
  const missing = [
    !v.company && 'cégnév',
    !(v.zip && v.city && v.address) && 'cím',
    !(v.billing_email || v.email) && 'e-mail',
    !p.info?.tax_number && 'adószám',
  ].filter(Boolean);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ font: `700 19px ${FONT_H}`, color: C.navy, flex: 1 }}>Számlázási adatok</b>
        <span style={{ font: `400 13px ${FONT}`, color: missing.length ? C.neg : C.inc }}>
          {missing.length ? `Hiányzik: ${missing.join(', ')}` : 'Minden adat megvan a számlához'}
        </span>
      </div>
      <div style={{ ...card, padding: 16, display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {PROFILE_FIELDS.map(([k, label, max]) => (
          <Field key={k} label={label} style={k === 'company' || k === 'address' ? { gridColumn: compact ? undefined : 'span 2' } : undefined}>
            <input
              value={v[k]}
              maxLength={max}
              disabled={!canEdit}
              type={k.includes('email') ? 'email' : 'text'}
              onChange={(e) => setV({ ...v, [k]: e.target.value })}
              onBlur={() => save()}
              style={{ ...inputStyle, height: 42 }}
            />
          </Field>
        ))}
        <Field label="Fizetési határidő (nap)">
          <input
            value={v.pay_days ?? ''}
            inputMode="numeric"
            disabled={!canEdit}
            placeholder="pl. 8"
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, '').slice(0, 3);
              setV({ ...v, pay_days: d === '' ? null : Number(d) });
            }}
            onBlur={() => save()}
            style={{ ...inputStyle, height: 42 }}
          />
        </Field>
        <div style={{ ...eyebrow, gridColumn: '1 / -1', textTransform: 'none', letterSpacing: 0, font: `400 12.5px ${FONT}` }}>
          Adószám: <b style={{ color: C.navy }}>{p.info?.tax_number || 'nincs megadva'}</b> (a Beállítások fülön szerkeszthető) · a mezők elhagyásakor
          automatikusan mentődik
        </div>
      </div>
    </section>
  );
}

/** rövid kártya a partnertörzs jobb oldali paneljébe: aktív szolgáltatások + mostani számlázandó összeg */
export function PartnerServicesSummary({ p, onOpen }: { p: PartnerStat; onOpen: () => void }) {
  const { data } = useStore();
  const ym = data.today.slice(0, 7);
  const products = data.products || [];
  const rows = (data.partnerProducts || []).filter((a) => a.partner_key === p.key && (!a.end_ym || a.end_ym >= ym));
  const now = billablesFor(ym, rows, products);
  const byId = new Map(products.map((x) => [x.id, x]));
  return (
    <div style={{ padding: '14px 0', borderTop: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...eyebrow, flex: 1 }}>Szolgáltatások, termékek</span>
        <Pill small onClick={onOpen}>
          Kezelés ›
        </Pill>
      </div>
      {!rows.length && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Nincs hozzárendelt szolgáltatás.</span>}
      {rows.map((a) => {
        const pr = byId.get(a.product_id);
        const e = effective(a, pr);
        return (
          <div
            key={a.id}
            style={{ display: 'flex', gap: 8, font: `400 13.5px ${FONT}`, color: C.ink, padding: '6px 10px', borderRadius: R.md, background: C.bg }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pr?.name || 'Törölt termék'} · {BILLING_LABEL[e.billing].toLowerCase()}
            </span>
            <b style={{ fontVariantNumeric: 'tabular-nums', color: C.navy }}>{money(e.net, pr?.currency)}</b>
          </div>
        );
      })}
      {now.length > 0 && (
        <span style={{ font: `600 13px ${FONT}`, color: C.inc }}>
          {monthLong(ym)}: számlázandó nettó {money(now.reduce((s, l) => s + l.net, 0))}
        </span>
      )}
    </div>
  );
}
