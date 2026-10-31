// Partner adatlap: bárhonnan a partner nevére kattintva nyílik. Felül a partnertörzs adatai (név, típus, alternatív nevek,
// adószám, megjegyzés, projektek), alatta a tervezett feladatok (mit számlázunk neki / mit fizetünk neki), majd a statisztika.
// A PartnerEditor a partnertörzs oldalon is ugyanez.
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { offerConversion } from '../../shared/insights';
import { RejectedOffers } from './RejectedOffers';
import { addMonths, fmt, monthLabel } from '../../shared/model';
import { partnerIdOf, partnerStats, type PartnerStat } from '../../shared/partners';
import type { Partner, Section } from '../../shared/types';
import { dayNameHu, payDate, payRuleLabel } from '../../shared/workdays';
import { sheetIdOf } from '../../shared/worktime';
import { api } from './api';
import { importWorkbook } from './BreakevenView';
import { acceptOffer, payDefaults, rowKey } from './logic';
import { MobilePartnerScreen } from './MobileFlows';
import { PartnerModal } from './PartnerModal';
import { PartnerSheet } from './PartnerSheet';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Modal, Pill, Seg, card, eyebrow, inputStyle, R } from './ui';

type Kind = NonNullable<Partner['kind']> | 'auto';
const KIND_LABEL: Record<NonNullable<Partner['kind']>, string> = { vevo: 'Vevő', szallito: 'Szállító', mindketto: 'Vevő és szállító' };
const dd = (d: string) => d.replace(/-/g, '.') + '.';

/** Az összes partner (a forgalom nélküliek is), a partnertörzs adataival. */
export function useAllPartners() {
  const { data, ix } = useStore();
  return useMemo(
    () => partnerStats(data.entries, ix.leaves, ix.groups, data.billingo, data.today, data.partnerNames || [], data.partners || [], true),
    [data.entries, data.billingo, data.today, data.partnerNames, data.partners, ix],
  );
}

/** A partner típusa: a partnertörzsből, vagy a kategóriákból (bevételi oldal = vevő, kiadási = szállító). */
export function kindOf(p: PartnerStat, sectionOf: (leaf: string) => Section): NonNullable<Partner['kind']> {
  if (p.info?.kind) return p.info.kind;
  const secs = new Set(p.leaves.map((l) => sectionOf(l.id)));
  return secs.has('in') && secs.has('out') ? 'mindketto' : secs.has('in') ? 'vevo' : 'szallito';
}

export function PartnerEditor({
  p,
  onSaved,
  compact,
  part = 'all',
  onPick,
}: {
  p: PartnerStat;
  onSaved?: (key: string) => void;
  /** Partnertörzs: másik partner kiválasztása a mappa-listából */
  onPick?: (key: string) => void;
  compact?: boolean;
  /** basic = név + típus (adatlap 1. fül), company = cégadatok + mappák (2. fül), all = minden (partnertörzs) */
  part?: 'basic' | 'company' | 'all' | 'settings' | 'panel';
}) {
  const { ix, data, run, canEdit } = useStore();
  const [browse, setBrowse] = useState(false);
  const [browseG, setBrowseG] = useState<string | null>(null);
  const [name, setName] = useState(p.name);
  // a típus mindig egyértelmű: ha a partnertörzsben nincs megadva, a mappák szerint (bevétel / projekt = vevő, kiadás = szállító)
  const [kind, setKind] = useState<Kind>(p.info?.kind || kindOf(p, ix.sectionOf));
  const [aliases, setAliases] = useState<string[]>(p.info?.aliases || []);
  const [alias, setAlias] = useState('');
  // máshol (pl. a Számlázási nevek dobozban) hozzárendelt név is látszódjon itt, és a következő mentés ne vesse el
  const aliasesKey = JSON.stringify(p.info?.aliases || []);
  useEffect(() => setAliases(p.info?.aliases || []), [aliasesKey]);
  const [tax, setTax] = useState(p.info?.tax_number || '');
  const [note, setNote] = useState(p.info?.note || '');
  const addAlias = (a: string) => {
    const s = a.replace(/\s+/g, ' ').trim();
    if (s.length < 2 || aliases.some((x) => normalizeText(x) === normalizeText(s))) return;
    const next = [...aliases, s];
    setAliases(next);
    setAlias('');
    persist({ aliases: next });
  };
  // javaslat: a Billingo-számlákon és a banki tételekben szereplő nevek, amik még nincsenek az alternatív nevek között
  const suggest = p.billingNames.filter(
    (b) => normalizeText(b.name) !== normalizeText(name) && !aliases.some((a) => normalizeText(a) === normalizeText(b.name)),
  );
  // választható nevek: banki küldők/kedvezményezettek, Billingo- és NAV-partnerek, a többi partner neve
  const known = useMemo(() => {
    const seen = new Set<string>([normalizeText(name), ...aliases.map(normalizeText)]);
    const out: string[] = [];
    const add = (s: string | null | undefined) => {
      const t = String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
      const n = normalizeText(t);
      if (n.length < 2 || seen.has(n)) return;
      seen.add(n);
      out.push(t);
    };
    data.bankTx.forEach((t) => add(t.partner));
    (data.partnerNames || []).forEach((x) => add(x.partner));
    data.billingo.forEach((d) => add(d.partner));
    (data.navInvoices || []).forEach((n) => add(n.partner_name));
    ix.leaves.forEach((l) => add(l.label));
    return out.sort((a, b) => a.localeCompare(b, 'hu'));
  }, [data.bankTx, data.partnerNames, data.billingo, data.navInvoices, ix.leaves, name, aliases]);
  // a nevek előfordulása: hányszor és hol (Billingo-számla, banki tétel, NAV-számla) – a párosítás ezek alapján történik
  const occ = useMemo(() => {
    const nz = (x: string) => normalizeText(x).replace(/[^a-z0-9]/g, '');
    const m = new Map<string, { src: string; n: number }[]>();
    for (const a of aliases) {
      const k = nz(a);
      if (k.length < 3) continue;
      const bill = data.billingo.filter((d) => !d.cancelled && nz(d.partner || '').includes(k)).length;
      const bank = data.bankTx.filter((t) => nz(`${t.partner || ''} ${t.memo || ''}`).includes(k)).length;
      const nav = (data.navInvoices || []).filter((n) => nz(n.partner_name || '').includes(k)).length;
      m.set(
        a,
        [
          { src: 'Billingo', n: bill },
          { src: 'bank', n: bank },
          { src: 'NAV', n: nav },
        ].filter((x) => x.n > 0),
      );
    }
    return m;
  }, [aliases, data.billingo, data.bankTx, data.navInvoices]);
  const listId = 'aliases-' + p.key;
  // adószám a NAV-számlákból (ha a partnertörzsben még nincs)
  const navTax = useMemo(() => {
    const ids = new Set(p.leaves.map((l) => l.id));
    const ents = new Set(data.entries.filter((e) => ids.has(e.leaf_id)).map((e) => e.id));
    const n = (data.navInvoices || []).find(
      (x) => x.partner_tax && ((x.leaf_id && ids.has(x.leaf_id)) || (x.plan_id && ents.has(x.plan_id)) || (x.actual_id && ents.has(x.actual_id))),
    );
    return n?.partner_tax || null;
  }, [p.leaves, data.entries, data.navInvoices]);
  /** automatikus mentés: a szövegmezők elhagyásakor, a típus és az alternatív nevek változásakor azonnal */
  const persist = (over: Partial<{ name: string; kind: Kind; aliases: string[]; tax: string; note: string }> = {}) => {
    const v = { name, kind, aliases, tax, note, ...over };
    if (!canEdit || !v.name.trim()) return;
    const same =
      v.name.trim() === p.name &&
      v.kind === (p.info?.kind || '') &&
      JSON.stringify(v.aliases) === JSON.stringify(p.info?.aliases || []) &&
      v.tax === (p.info?.tax_number || '') &&
      v.note === (p.info?.note || '');
    if (same) return;
    run(async () => {
      const r = await api<{ key: string }>(`/api/partners/${encodeURIComponent(p.key)}`, {
        method: 'PUT',
        body: { name: v.name.trim(), kind: v.kind === 'auto' ? null : v.kind, aliases: v.aliases, tax_number: v.tax, note: v.note },
      });
      onSaved?.(r.key);
    }, 'Partner mentve');
  };
  const moveLeaf = (leafId: string, group_id: string) => run(() => api(`/api/leaves/${leafId}`, { method: 'PATCH', body: { group_id } }), 'Projekt módosítva');
  const addRole = (group_id: string) => run(() => api('/api/leaves', { body: { group_id, label: p.name } }), 'Hozzáadva');

  if (part === 'panel') {
    // Partnertörzs jobb oldali gyors szerkesztője (látványterv): név, típus, felismert nevek, adószám, megjegyzés, hova tartozik
    const k = kind === 'auto' ? kindOf(p, ix.sectionOf) : kind;
    const mainLeaf = p.leaves[0];
    const sec: Section = k === 'szallito' ? 'out' : k === 'vevo' ? 'in' : mainLeaf ? ix.sectionOf(mainLeaf.id) : 'in';
    const groups = ix.groups.filter((g) => g.section === sec);
    const curG = browseG || mainLeaf?.group_id || groups[0]?.id;
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PanelRow title="Név">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => persist()}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            disabled={!canEdit}
            style={{ ...inputStyle, height: 44, font: `500 15px ${FONT}` }}
          />
        </PanelRow>
        <PanelRow title="Típus">
          <div style={{ alignSelf: 'flex-start' }}>
            <Seg
              value={kind}
              onChange={(v) => {
                if (!canEdit) return;
                setKind(v);
                persist({ kind: v });
              }}
              options={[
                ['vevo', 'Vevő'],
                ['szallito', 'Szállító'],
                ['mindketto', 'Mindkettő'],
              ]}
            />
          </div>
        </PanelRow>
        <PanelRow title="Felismert nevek" sub="cégnév, Billingo-, banki név, üzlet/kút neve">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', border: `1px solid ${C.line2}`, borderRadius: R.lg, padding: 6 }}>
            {aliases.map((a) => (
              <span
                key={a}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '5px 6px 5px 12px',
                  borderRadius: 999,
                  background: C.bg2,
                  font: `600 13px ${FONT}`,
                  color: C.navy,
                }}
              >
                {a}
                {canEdit && (
                  <button
                    onClick={() => {
                      const next = aliases.filter((x) => x !== a);
                      setAliases(next);
                      persist({ aliases: next });
                    }}
                    title="Eltávolítás"
                    aria-label="Név eltávolítása"
                    style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.muted, font: `700 13px ${FONT}`, padding: '0 4px' }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <input
                value={alias}
                list={listId}
                onChange={(e) => {
                  const v = e.target.value;
                  if (known.includes(v)) addAlias(v);
                  else setAlias(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addAlias(alias);
                  }
                }}
                onBlur={() => alias.trim() && addAlias(alias)}
                placeholder="Kezdd gépelni (pl. SZIGNETTA)…"
                style={{ flex: '1 1 160px', minWidth: 120, border: 0, outline: 'none', font: `500 14px ${FONT}`, color: C.ink, padding: '6px 8px' }}
              />
            )}
            <datalist id={listId}>
              {known.slice(0, 400).map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </div>
          <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>Ezek alapján párosít és összevon · válassz a listából, vagy új név + Enter</span>
          {canEdit && suggest.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>Lehet, hogy ez is ő:</span>
              {suggest.slice(0, 4).map((b) => (
                <button
                  key={b.source + b.name}
                  onClick={() => addAlias(b.name)}
                  style={{
                    border: `1.5px dashed ${C.blue}`,
                    background: '#fff',
                    borderRadius: 999,
                    padding: '4px 10px',
                    font: `600 12px ${FONT}`,
                    color: C.blueDark,
                    cursor: 'pointer',
                  }}
                >
                  + {b.name} · {b.source}
                </button>
              ))}
            </div>
          )}
        </PanelRow>
        <PanelRow title="Adószám">
          <input
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            onBlur={() => persist()}
            disabled={!canEdit}
            placeholder="12345678-2-13"
            style={{ ...inputStyle, height: 44, maxWidth: 240 }}
          />
          {canEdit && navTax && navTax !== tax && (
            <button
              type="button"
              onClick={() => {
                setTax(navTax);
                persist({ tax: navTax });
              }}
              style={{
                alignSelf: 'flex-start',
                border: 0,
                background: 'transparent',
                padding: 0,
                color: C.blueDark,
                font: `600 12px ${FONT}`,
                cursor: 'pointer',
              }}
            >
              NAV-számla szerint: {navTax} – beírom
            </button>
          )}
        </PanelRow>
        <PanelRow title="Megjegyzés">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => persist()}
            disabled={!canEdit}
            placeholder="kapcsolattartó, szerződés, egyéb"
            style={{ ...inputStyle, height: 44 }}
          />
        </PanelRow>
        <PanelRow title="Hova tartozik" sub={sec === 'in' ? 'Bevétel (vevőként)' : 'Kiadás (szállítóként)'}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(150px,1fr) minmax(0,1fr)',
              border: `1px solid ${C.line}`,
              borderRadius: R.lg,
              overflow: 'hidden',
            }}
          >
            <div style={{ borderRight: `1px solid ${C.line}`, padding: 6, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {groups.map((g) => {
                const on = curG === g.id;
                const mine = mainLeaf?.group_id === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    title={mine ? 'Itt van' : 'Kattints a mappára a tartalmáért; a „Áthelyezés ide” gombbal kerül át'}
                    onClick={() => setBrowseG(g.id)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      border: 0,
                      borderRadius: R.md,
                      padding: '8px 10px',
                      background: on ? C.bg : 'transparent',
                      font: `${mine ? 700 : 500} 13.5px ${FONT}`,
                      color: C.navy,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span>{displayGroup(g.label)}</span>
                    <span style={{ font: `500 11.5px ${FONT}`, color: C.faint }}>{ix.leaves.filter((l) => l.group_id === g.id && !l.archived).length}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ padding: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignContent: 'flex-start', maxHeight: 280, overflowY: 'auto' }}>
              {ix.leaves
                .filter((l) => l.group_id === curG && !l.archived)
                .sort((a, b) => a.label.localeCompare(b.label, 'hu'))
                .map((l) => {
                  const me = p.leaves.some((x) => x.id === l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => !me && onPick?.(partnerIdOf(l.label))}
                      title={me ? 'ez a partner' : 'partner kiválasztása'}
                      style={{
                        border: `1px solid ${me ? C.navy : C.line2}`,
                        borderRadius: 999,
                        padding: '5px 12px',
                        background: me ? C.navy : '#fff',
                        color: me ? '#fff' : C.blueDark,
                        font: `600 12.5px ${FONT}`,
                        cursor: me ? 'default' : 'pointer',
                      }}
                    >
                      {me ? '● ' : ''}
                      {l.label}
                    </button>
                  );
                })}
              {canEdit && mainLeaf && curG && curG !== mainLeaf.group_id && (
                <button
                  type="button"
                  onClick={() => moveLeaf(mainLeaf.id, curG)}
                  style={{
                    border: `1.5px dashed ${C.blue}`,
                    borderRadius: 999,
                    padding: '5px 12px',
                    background: '#fff',
                    color: C.blueDark,
                    font: `600 12.5px ${FONT}`,
                    cursor: 'pointer',
                  }}
                >
                  + Áthelyezés ide
                </button>
              )}
            </div>
          </div>
        </PanelRow>
      </div>
    );
  }

  if (part === 'settings') {
    // adatlap › Beállítások (látványterv): soronként felirat + mező
    const k = kind === 'auto' ? kindOf(p, ix.sectionOf) : kind;
    const mainLeaf = p.leaves[0];
    const groups = ix.groups.filter((g) => k === 'mindketto' || g.section === (k === 'vevo' ? 'in' : 'out'));
    const cnt = (gid: string) => ix.leaves.filter((l) => l.group_id === gid && !l.archived).length;
    return (
      <>
        <SettingRow title="Típus" sub="Vevő = bevétel, szállító = kiadás">
          <div style={{ alignSelf: 'flex-start' }}>
            <Seg
              value={kind}
              onChange={(v) => {
                if (!canEdit) return;
                setKind(v);
                persist({ kind: v });
              }}
              options={[
                ['vevo', 'Vevő'],
                ['szallito', 'Szállító'],
                ['mindketto', 'Mindkettő'],
              ]}
            />
          </div>
        </SettingRow>
        <SettingRow title="Kategória" sub="Ide kerülnek a tételei">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {mainLeaf && (
              <select
                value={mainLeaf.group_id}
                disabled={!canEdit}
                onChange={(e) => moveLeaf(mainLeaf.id, e.target.value)}
                style={{ ...inputStyle, height: 44, minWidth: 300, font: `600 15px ${FONT}`, color: C.navy }}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.section === 'in' ? 'Bevétel' : 'Kiadás'} › {displayGroup(g.label)} · {cnt(g.id)} partner
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setBrowse(!browse)}
              style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 14px ${FONT}`, cursor: 'pointer', padding: 0 }}
            >
              {browse ? 'Mappák elrejtése ‹' : 'Mappák böngészése ›'}
            </button>
          </div>
          <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
            {p.leaves.length > 1 ? `${p.leaves.length} helyen szerepel – a többit a mappafában látod. ` : ''}A teljes mappafa a „Mappák böngészése” alatt nyílik
            meg.
          </span>
          {browse && <FolderTree p={p} kind={k} canEdit={canEdit} onMove={moveLeaf} onAdd={addRole} />}
        </SettingRow>
        <SettingRow title="Nevek" sub="Ezek alapján párosít és összevon: cégnév, Billingo-, NAV-, banki név, üzlet neve">
          <div style={{ border: `1px solid ${C.line2}`, borderRadius: R.lg, overflow: 'hidden' }}>
            {aliases.map((a) => {
              const where = occ.get(a) || [];
              return (
                <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: `1px solid ${C.line3}` }}>
                  <b style={{ flex: 1, minWidth: 0, font: `600 15px ${FONT}`, color: C.navy }}>{a}</b>
                  {where.length ? (
                    where.map((w) => (
                      <span key={w.src} style={{ padding: '2px 10px', borderRadius: 999, background: C.bg2, color: C.blueDark, font: `600 12px ${FONT}` }}>
                        {w.src} · {w.n}×
                      </span>
                    ))
                  ) : (
                    <span style={{ font: `500 12px ${FONT}`, color: C.faint }}>még nem fordult elő</span>
                  )}
                  <span style={{ padding: '2px 10px', borderRadius: 999, background: C.bg2, color: C.blueDark, font: `600 12px ${FONT}` }}>✓ párosít</span>
                  {canEdit && (
                    <button
                      onClick={() => {
                        const next = aliases.filter((x) => x !== a);
                        setAliases(next);
                        persist({ aliases: next });
                      }}
                      title="Eltávolítás"
                      aria-label="Név eltávolítása"
                      style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.muted, font: `700 15px ${FONT}`, padding: '0 4px' }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            {canEdit && (
              <input
                value={alias}
                list={listId}
                onChange={(e) => {
                  const v = e.target.value;
                  if (known.includes(v)) addAlias(v);
                  else setAlias(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addAlias(alias);
                  }
                }}
                onBlur={() => alias.trim() && addAlias(alias)}
                placeholder="+ Név hozzáadása – keresés a Billingo-, NAV- és banki nevek között…"
                style={{ width: '100%', border: 0, outline: 'none', padding: '12px 14px', font: `500 14px ${FONT}`, color: C.ink, boxSizing: 'border-box' }}
              />
            )}
            <datalist id={listId}>
              {known.slice(0, 400).map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </div>
          {canEdit && suggest.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Lehet, hogy ez is ő:</span>
              {suggest.slice(0, 6).map((b) => (
                <button
                  key={b.source + b.name}
                  onClick={() => addAlias(b.name)}
                  style={{
                    border: `1.5px dashed ${C.blue}`,
                    background: '#fff',
                    borderRadius: 999,
                    padding: '5px 12px',
                    font: `600 13px ${FONT}`,
                    color: C.blueDark,
                    cursor: 'pointer',
                  }}
                >
                  + {b.name} · {b.source}
                </button>
              ))}
            </div>
          )}
        </SettingRow>
        <SettingRow title="Adószám és megjegyzés">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)', gap: 12 }}>
            <input
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              onBlur={() => persist()}
              disabled={!canEdit}
              placeholder="12345678-2-13"
              style={{ ...inputStyle, height: 44 }}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => persist()}
              disabled={!canEdit}
              placeholder="kapcsolattartó, szerződés, egyéb"
              style={{ ...inputStyle, height: 44 }}
            />
          </div>
          {canEdit && navTax && navTax !== tax && (
            <button
              type="button"
              onClick={() => {
                setTax(navTax);
                persist({ tax: navTax });
              }}
              style={{
                alignSelf: 'flex-start',
                border: 0,
                background: 'transparent',
                padding: 0,
                color: C.blueDark,
                font: `600 12.5px ${FONT}`,
                cursor: 'pointer',
              }}
            >
              NAV-számla szerint: {navTax} – beírom
            </button>
          )}
        </SettingRow>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {part !== 'company' && (
        <div style={{ display: 'grid', gridTemplateColumns: compact || part === 'basic' ? '1fr' : '1fr 1fr', gap: 10 }}>
          <Field label="Név">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => persist()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              disabled={!canEdit}
              style={{ ...inputStyle, height: 42 }}
            />
          </Field>
          {!part && (
            <Field label="Típus">
              <Seg
                small
                value={kind}
                onChange={(v) => {
                  if (!canEdit) return;
                  setKind(v);
                  persist({ kind: v });
                }}
                options={[
                  ['vevo', 'Vevő'],
                  ['szallito', 'Szállító'],
                  ['mindketto', 'Mindkettő'],
                ]}
              />
            </Field>
          )}
        </div>
      )}

      {part === 'company' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
          <Field label="Típus">
            <Seg
              small
              value={kind}
              onChange={(v) => {
                if (!canEdit) return;
                setKind(v);
                persist({ kind: v });
              }}
              options={[
                ['vevo', 'Vevő'],
                ['szallito', 'Szállító'],
                ['mindketto', 'Mindkettő'],
              ]}
            />
          </Field>
        </div>
      )}

      {part !== 'basic' && (
        <>
          <Field label="Alternatív nevek – cégnév, Billingo-számlanév, banki név, üzlet/kút neve (ezek alapján párosít és összevon)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {aliases.map((a) => (
                <span
                  key={a}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 6px 5px 12px',
                    borderRadius: 999,
                    background: C.bg2,
                    font: `600 13px ${FONT}`,
                    color: C.navy,
                  }}
                >
                  {a}
                  {canEdit && (
                    <button
                      onClick={() => {
                        const next = aliases.filter((x) => x !== a);
                        setAliases(next);
                        persist({ aliases: next });
                      }}
                      title="Eltávolítás"
                      aria-label="Név eltávolítása"
                      style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.muted, font: `700 14px ${FONT}`, padding: '0 4px' }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <input
                  value={alias}
                  list={listId}
                  onChange={(e) => {
                    const v = e.target.value;
                    // a listából választott név azonnal bekerül; begépelt új név Enterre
                    if (known.includes(v)) addAlias(v);
                    else setAlias(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addAlias(alias);
                    }
                  }}
                  onBlur={() => alias.trim() && addAlias(alias)}
                  placeholder={
                    aliases.length
                      ? 'Kezdd gépelni – válassz a listából, vagy új név + Enter'
                      : 'Kezdd gépelni (pl. SZIGNETTA) – válassz a listából, vagy új név + Enter'
                  }
                  style={{ ...inputStyle, height: 36, flex: '1 1 220px', minWidth: 180 }}
                />
              )}
              <datalist id={listId}>
                {known.slice(0, 400).map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </div>
            {canEdit && suggest.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>Javaslat a számlákból / bankból:</span>
                {suggest.slice(0, 8).map((b) => (
                  <button
                    key={b.source + b.name}
                    onClick={() => addAlias(b.name)}
                    style={{
                      border: `1px dashed ${C.line2}`,
                      background: '#fff',
                      borderRadius: 999,
                      padding: '4px 10px',
                      font: `600 12px ${FONT}`,
                      color: C.blueDark,
                      cursor: 'pointer',
                    }}
                  >
                    + {b.name}
                  </button>
                ))}
              </div>
            )}
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 2fr', gap: 10 }}>
            <Field label="Adószám">
              <input
                value={tax}
                onChange={(e) => setTax(e.target.value)}
                onBlur={() => persist()}
                disabled={!canEdit}
                placeholder="12345678-2-13"
                style={{ ...inputStyle, height: 40 }}
              />
              {canEdit && navTax && navTax !== tax && (
                <button
                  type="button"
                  onClick={() => {
                    setTax(navTax);
                    persist({ tax: navTax });
                  }}
                  style={{
                    alignSelf: 'flex-start',
                    border: 0,
                    background: 'transparent',
                    padding: '4px 0 0',
                    color: C.blueDark,
                    font: `600 12px ${FONT}`,
                    cursor: 'pointer',
                  }}
                >
                  NAV-számla szerint: {navTax} – beírom
                </button>
              )}
            </Field>
            <Field label="Megjegyzés">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => persist()}
                disabled={!canEdit}
                placeholder="kapcsolattartó, szerződés, egyéb"
                style={{ ...inputStyle, height: 40 }}
              />
            </Field>
          </div>
        </>
      )}

      {part !== 'basic' && (
        <Field label="Hova tartozik – mappák (a típus szerint: vevő = bevétel, szállító = kiadás)">
          <FolderTree p={p} kind={kind === 'auto' ? kindOf(p, ix.sectionOf) : kind} canEdit={canEdit} onMove={moveLeaf} onAdd={addRole} />
        </Field>
      )}
    </div>
  );
}

/**
 * Egy partner-sor (projekt) kezelése a mappafában: átnevezés, összevonás a partner másik sorával (minden tétel, banki tétel,
 * szabály átkerül, semmi nem vész el), áthelyezés másik mappába, tételek szerkesztése, megszüntetés (archiválás).
 */
function LeafActions({ leafId, siblings, onDone }: { leafId: string; siblings: { id: string; label: string; group_id: string }[]; onDone: () => void }) {
  const { ix, data, run } = useStore();
  const L = ix.leafById[leafId];
  const [name, setName] = useState(L?.label || '');
  const [items, setItems] = useState(false);
  const [mergeQ, setMergeQ] = useState('');
  if (!L) return null;
  const sec = ix.sectionOf(leafId);
  const es = data.entries.filter((e) => e.leaf_id === leafId);
  const openN = es.filter((e) => e.kind === 'plan' && !e.done).length;
  const actN = es.filter((e) => e.kind === 'actual').length;
  const others = ix.leaves.filter((l) => l.id !== leafId && !l.archived && ix.sectionOf(l.id) === sec);
  const sib = new Set(siblings.map((x) => x.id));
  // hasonló nevűek (pl. „Orange Home” ↔ „OrangeHomes”, „Orvosmost” ↔ „Orvosmost UrgentCare”): írásjel/szóköz nélkül az egyik a másik eleje
  const compact = (x: string) => normalizeText(x).replace(/[^a-z0-9]/g, '');
  const me = compact(L?.label || '');
  const similar = (x: string) => {
    const o = compact(x);
    const a = me.length <= o.length ? me : o,
      b = me.length <= o.length ? o : me;
    return a.length >= 4 && b.startsWith(a.slice(0, Math.max(4, a.length - 1)));
  };
  const cands = mergeQ.trim()
    ? others.filter((l) => normalizeText(l.label).includes(normalizeText(mergeQ))).slice(0, 8)
    : others.filter((l) => sib.has(l.id) || similar(l.label)).slice(0, 8);
  const gl = (id: string) => displayGroup(ix.groupById[ix.leafById[id]?.group_id]?.label || '');
  const rename = () => {
    const v = name.trim();
    if (!v || v === L.label) return;
    run(() => api(`/api/leaves/${leafId}`, { method: 'PATCH', body: { label: v } }), `Átnevezve: ${L.label} → ${v}`);
  };
  const merge = (into: { id: string; label: string }) => {
    if (
      !confirm(
        `„${L.label}” (${gl(leafId)}) összevonása ide: „${into.label}” (${gl(into.id)})?\n\nMinden tétele (${es.length}: ${openN} nyitott terv, ${actN} tény), banki tétele és párosítási szabálya átkerül, a régi név a jövőben is ide párosul. A „${L.label}” sor megszűnik.`,
      )
    )
      return;
    run(
      () => api(`/api/leaves/${leafId}/merge`, { body: { into: into.id } }),
      `${L.label} → ${into.label} összevonva · visszavonható: Beállítások › Napló`,
    ).then(onDone);
  };
  const archive = () => {
    if (openN) {
      alert(
        `„${L.label}” sorban még ${openN} nyitott terv van. Előbb vond össze egy másik sorral, vagy töröld / helyezd át a tételeit („Tételek szerkesztése”).`,
      );
      return;
    }
    if (
      !confirm(
        `„${L.label}” megszüntetése? A múltbeli tételei megmaradnak (a statisztikában látszanak), csak a választólistákban nem jelenik meg többé. Visszaállítani a Beállítások → Kategóriák alatt lehet.`,
      )
    )
      return;
    run(() => api(`/api/leaves/${leafId}`, { method: 'PATCH', body: { archived: 1 } }), `${L.label} megszüntetve (archiválva)`).then(onDone);
  };
  const row: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' };
  const lab: CSSProperties = { font: `600 10.5px ${FONT}`, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted, minWidth: 92 };
  return (
    <div
      style={{
        margin: '2px 0 8px 8px',
        padding: 10,
        borderRadius: R.lg,
        background: C.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        font: `500 12.5px ${FONT}`,
      }}
    >
      <span style={{ color: C.muted }}>
        {es.length} tétel · {openN} nyitott terv · {actN} tény
      </span>
      <div style={row}>
        <span style={lab}>Átnevezés</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          style={{ ...inputStyle, height: 34, flex: '1 1 180px' }}
        />
      </div>
      <div style={row}>
        <span style={lab}>Összevonás</span>
        {cands.map((l) => (
          <Pill key={l.id} small kind="primary" onClick={() => merge(l)}>
            → {l.label} ({gl(l.id)})
          </Pill>
        ))}
        <input
          value={mergeQ}
          onChange={(e) => setMergeQ(e.target.value)}
          placeholder="másik partner keresése…"
          style={{ ...inputStyle, height: 32, flex: '1 1 160px' }}
        />
      </div>
      <div style={row}>
        <span style={lab}>Mappa</span>
        {ix.groups
          .filter((g) => g.section === sec)
          .map((g) => (
            <Pill
              key={g.id}
              small
              kind={g.id === L.group_id ? 'dark' : undefined}
              onClick={() =>
                g.id !== L.group_id &&
                run(() => api(`/api/leaves/${leafId}`, { method: 'PATCH', body: { group_id: g.id } }), `${L.label} → ${displayGroup(g.label)}`)
              }
            >
              {displayGroup(g.label)}
            </Pill>
          ))}
      </div>
      <div style={row}>
        <Pill small onClick={() => setItems(true)}>
          Tételek szerkesztése / áthelyezése…
        </Pill>
        <Pill small kind="danger" onClick={archive}>
          Megszüntetés
        </Pill>
        <Pill small onClick={onDone}>
          Bezár
        </Pill>
      </div>
      {items && <PartnerModal leaf={leafId} onClose={() => setItems(false)} />}
    </div>
  );
}

/**
 * Mappaszerkezet: Bevétel és Kiadás oszlop, alattuk a csoportok (mappák). Ahol a partner szerepel, az ki van jelölve.
 * Másik mappára kattintva: áthelyezés oda (a meglévő szerepből), vagy hozzáadás (új szerep ugyanazzal a névvel).
 */
function FolderTree({
  p,
  kind,
  canEdit,
  onMove,
  onAdd,
}: {
  p: PartnerStat;
  kind: NonNullable<Partner['kind']>;
  canEdit: boolean;
  onMove: (leafId: string, groupId: string) => void;
  onAdd: (groupId: string) => void;
}) {
  const { ix, openPartner } = useStore();
  const [pick, setPick] = useState<string | null>(null);
  const [act, setAct] = useState<string | null>(null);
  const [openG, setOpenG] = useState<Set<string>>(() => new Set(p.leaves.map((l) => l.group_id)));
  const toggle = (id: string) =>
    setOpenG((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const col = (sec: Section) => {
    const mine = p.leaves.filter((l) => ix.sectionOf(l.id) === sec);
    return (
      <div
        style={{
          flex: '1 1 260px',
          minWidth: 0,
          border: `1px solid ${C.line2}`,
          borderRadius: R.lg,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <b style={{ font: `700 13px ${FONT}`, color: sec === 'in' ? C.blueDark : C.navy, marginBottom: 4 }}>
          {sec === 'in' ? '📂 Bevétel (vevőként)' : '📂 Kiadás (szállítóként)'}
        </b>
        {ix.groups
          .filter((g) => g.section === sec)
          .map((g) => {
            const here = mine.filter((l) => l.group_id === g.id);
            const on = here.length > 0;
            const members = ix.leaves.filter((l) => l.group_id === g.id && !l.archived).sort((a, b) => a.label.localeCompare(b.label, 'hu'));
            const expanded = openG.has(g.id);
            return (
              <div key={g.id}>
                <button
                  type="button"
                  onClick={() => toggle(g.id)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    border: 0,
                    borderRadius: R.md,
                    padding: '6px 8px',
                    background: on ? C.bg3 : pick === g.id ? C.bg2 : 'transparent',
                    font: `${on ? 700 : 500} 13px ${FONT}`,
                    color: on ? C.navy : C.ink,
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 6,
                  }}
                >
                  <span style={{ width: 12, color: C.muted }}>{expanded ? '▾' : '▸'}</span>
                  <span>{on ? '📂' : '📁'}</span>
                  <span style={{ flex: 1 }}>{displayGroup(g.label)}</span>
                  <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>{members.length}</span>
                </button>
                {expanded && (
                  <div style={{ padding: '0 0 6px 30px', display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 260, overflowY: 'auto' }}>
                    {members.map((l) => {
                      const self = here.some((h) => h.id === l.id);
                      return (
                        <Fragment key={l.id}>
                          <button
                            type="button"
                            onClick={() => (self ? canEdit && setAct(act === l.id ? null : l.id) : openPartner(l.id))}
                            title={self ? (canEdit ? 'Átnevezés, összevonás, áthelyezés, megszüntetés' : 'Ez a partner') : 'Partner adatlapja'}
                            style={{
                              border: 0,
                              background: self ? C.bg3 : 'transparent',
                              textAlign: 'left',
                              padding: '3px 8px',
                              borderRadius: R.md,
                              font: `${self ? 700 : 500} 12.5px ${FONT}`,
                              color: self ? C.navy : C.blueDark,
                              cursor: self && !canEdit ? 'default' : 'pointer',
                            }}
                          >
                            {self ? '● ' : '└ '}
                            {l.label}
                            {self && canEdit && <span style={{ font: `600 11px ${FONT}`, color: C.blueDark }}> {act === l.id ? '▾' : '· szerkesztés ›'}</span>}
                          </button>
                          {self && act === l.id && <LeafActions leafId={l.id} siblings={mine.filter((x) => x.id !== l.id)} onDone={() => setAct(null)} />}
                        </Fragment>
                      );
                    })}
                    {!members.length && <span style={{ font: `500 12px ${FONT}`, color: C.muted, padding: '2px 8px' }}>üres mappa</span>}
                    {canEdit && !on && (
                      <button
                        type="button"
                        onClick={() => setPick(pick === g.id ? null : g.id)}
                        style={{
                          border: 0,
                          background: 'transparent',
                          textAlign: 'left',
                          padding: '4px 8px',
                          font: `700 12.5px ${FONT}`,
                          color: C.blueDark,
                          cursor: 'pointer',
                        }}
                      >
                        {pick === g.id ? '× mégse' : `+ ${p.name} ide…`}
                      </button>
                    )}
                  </div>
                )}
                {pick === g.id && !on && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '4px 0 6px 30px' }}>
                    {mine.map((l) => (
                      <Pill
                        key={l.id}
                        small
                        kind="primary"
                        onClick={() => {
                          setPick(null);
                          onMove(l.id, g.id);
                        }}
                      >
                        Áthelyezés ide ({displayGroup(ix.groupById[l.group_id]?.label || '')} helyett)
                      </Pill>
                    ))}
                    <Pill
                      small
                      onClick={() => {
                        setPick(null);
                        onAdd(g.id);
                      }}
                    >
                      + {mine.length ? 'Ide is' : sec === 'in' ? 'Vevőként ide' : 'Szállítóként ide'}
                    </Pill>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {/* a típus szerinti oldal(ak); ha a partnernek a másik oldalon is van szerepe, az is látszik */}
      {(kind !== 'szallito' || p.leaves.some((l) => ix.sectionOf(l.id) === 'in')) && col('in')}
      {(kind !== 'vevo' || p.leaves.some((l) => ix.sectionOf(l.id) === 'out')) && col('out')}
    </div>
  );
}

/** Partnertörzs gyors-szerkesztő sora: balra felirat, jobbra mező. */
function PanelRow({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: 18, padding: '14px 0', borderBottom: `1px solid ${C.line3}` }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 10 }}>
        <b style={{ font: `600 14px ${FONT}`, color: C.navy }}>{title}</b>
        {sub && <span style={{ font: `400 12px/1.4 ${FONT}`, color: C.muted }}>{sub}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** Beállítás-sor: balra felirat + magyarázat, jobbra a mező (adatlap › Beállítások). */
export function SettingRow({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,280px) minmax(0,1fr)', gap: 24, padding: '18px 0', borderBottom: `1px solid ${C.line3}` }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{title}</b>
        {sub && <span style={{ font: `400 13px/1.4 ${FONT}`, color: C.muted }}>{sub}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** Szakaszcím: kis kék nagybetűs felirat vonallal. */
export function SecHead({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        font: `700 12px ${FONT}`,
        letterSpacing: '.18em',
        textTransform: 'uppercase',
        color: C.blue,
        padding: '22px 0 10px',
        borderBottom: `1px solid ${C.line3}`,
      }}
    >
      {children}
    </div>
  );
}

const TERM_MODES: [string, string][] = [
  ['inv', 'Számla a hónap 1. munkanapján + N nap'],
  ['day', 'Minden hónap adott napján'],
  ['month_start', 'Hónap eleje (1.)'],
  ['first_workday', 'Hónap első munkanapja'],
  ['last_workday', 'Hónap utolsó munkanapja'],
  ['month_end', 'Hónap vége'],
];

/** Fizetési feltételek partnerenként (alkategóriánként): mikor esedékes a rendszeres tétel – a tervek ehhez igazodnak. */
export function PaymentTerms({ p, rows }: { p: PartnerStat; rows?: boolean }) {
  const { ix } = useStore();
  if (rows)
    return (
      <>
        {p.leaves.map((l) => (
          <TermRow key={l.id} leafId={l.id} sec={ix.sectionOf(l.id)} avgLate={p.avgLate} rows />
        ))}
      </>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ font: `500 13px/1.5 ${FONT}`, color: C.muted }}>
        Itt adod meg, hogy ennél a partnernél általában mikor esedékes a fizetés. Ez minden hónapban így ismétlődik: az új rendszeres tervek ehhez a naphoz
        kerülnek, és a meglévő nyitott terveket is átütemezheted.
      </span>
      {p.leaves.map((l) => (
        <TermRow key={l.id} leafId={l.id} sec={ix.sectionOf(l.id)} avgLate={p.avgLate} />
      ))}
    </div>
  );
}

function TermRow({ leafId, sec, avgLate, rows }: { leafId: string; sec: Section; avgLate?: number | null; rows?: boolean }) {
  const { ix, data, run, commit, canEdit } = useStore();
  const L = ix.leafById[leafId];
  const rule = L?.pay_rule || '';
  const init = (): [string, number] => {
    const inv = rule.match(/^inv:(\d+)$/);
    if (inv) return ['inv', Number(inv[1])];
    const d = rule.match(/^day:(\d+)$/);
    if (d) return ['day', Number(d[1])];
    if (['first_workday', 'last_workday', 'month_start', 'month_end'].includes(rule)) return [rule, 0];
    return ['inv', L?.pay_days ?? payDefaults(data.settings, sec).payDays];
  };
  const [mode, setMode] = useState(init()[0]);
  const [n, setN] = useState(String(init()[1] || (mode === 'day' ? 10 : payDefaults(data.settings, sec).payDays)));
  const [resched, setResched] = useState(true);
  const clamp = (m: string, v: string) => Math.max(0, Math.min(m === 'day' ? 31 : 120, parseInt(v) || 0));
  const ruleOf = (m: string, v: string) => (m === 'inv' ? `inv:${clamp(m, v)}` : m === 'day' ? `day:${Math.max(1, clamp(m, v))}` : m);
  const newRule = ruleOf(mode, n);
  // a nyitott, rendszeres (nem Billingo-számlás) tervek, amiket az új szabály szerint át lehet ütemezni
  const open = data.entries.filter((e) => e.kind === 'plan' && !e.done && e.leaf_id === leafId && e.series_id && e.source !== 'billingo');
  const movedBy = (r: string) => open.map((e) => ({ e, to: payDate(e.date.slice(0, 7), r, Number(e.date.slice(8)) || 1) })).filter((x) => x.to !== x.e.date);
  const moved = movedBy(newRule);
  /** automatikus mentés: módváltáskor azonnal, a szám mező elhagyásakor */
  const save = (m = mode, v = n, rs = resched) => {
    const r = ruleOf(m, v);
    if (r === rule) return;
    const mv = movedBy(r);
    run(
      async () => {
        await api(`/api/leaves/${leafId}`, { method: 'PATCH', body: { pay_rule: r, ...(m === 'inv' ? { pay_days: clamp(m, v) } : {}) } });
        if (rs && mv.length) await commit({ upsert: mv.map((x) => ({ ...x.e, date: x.to })) }, `${L?.label}: ${mv.length} terv átütemezve`);
      },
      `${L?.label}: fizetési feltétel mentve – ${payRuleLabel(r)}`,
    );
  };
  const ym = data.today.slice(0, 7);
  const next = [0, 1, 2].map((i) => payDate(addMonths(ym, i), newRule, clamp(mode, n) || 1));
  const suggestDays = avgLate != null ? Math.max(10, Math.round(((mode === 'inv' ? clamp('inv', n) : 8) + avgLate) / 10) * 10) : 0;
  if (rows)
    return (
      <>
        <SecHead>
          Fizetés · {sec === 'in' ? 'vevőként (bevétel)' : 'szállítóként (kiadás)'} · {displayGroup(ix.groupById[L?.group_id || '']?.label || '')}
        </SecHead>
        <SettingRow title={sec === 'in' ? 'Mikor számlázunk?' : 'Mikor fizetünk?'} sub="Minden hónapban így ismétlődik; az új rendszeres tervek ide kerülnek">
          <div style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}>
            <Seg
              value={mode}
              onChange={(v: string) => {
                if (!canEdit) return;
                setMode(v);
                save(v);
              }}
              options={TERM_MODES.map(([v, l]) => [v, l.replace(' + N nap', '')]) as any}
            />
          </div>
        </SettingRow>
        {(mode === 'inv' || mode === 'day') && (
          <SettingRow
            title={mode === 'inv' ? 'Fizetési határidő' : 'A hónap napja'}
            sub={`Jelenleg: ${
              payRuleLabel(rule || null) === 'nincs szabály'
                ? `számla + ${L?.pay_days ?? payDefaults(data.settings, sec).payDays} nap (alapértelmezett)`
                : payRuleLabel(rule)
            }`}
          >
            <label style={{ display: 'flex', gap: 12, alignItems: 'center', font: `500 15px ${FONT}`, color: C.ink }}>
              <input
                value={n}
                onChange={(e) => setN(e.target.value.replace(/\D/g, ''))}
                onBlur={() => save()}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                disabled={!canEdit}
                style={{
                  ...inputStyle,
                  width: 72,
                  height: 44,
                  textAlign: 'center',
                  font: `700 16px ${FONT}`,
                  border: `1.5px solid ${C.blue}`,
                  background: C.bg2,
                }}
              />
              {mode === 'inv' ? 'nap a számlától' : '. nap (hétvégén az előző munkanap)'}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>Következő esedékességek:</span>
              {next.map((d) => (
                <span key={d} style={{ padding: '6px 14px', borderRadius: 999, background: C.bg, font: `600 14px ${FONT}`, color: C.navy }}>
                  {d.replace(/-/g, '.')}. <span style={{ fontWeight: 500, color: C.muted }}>{dayNameHu(d)}</span>
                </span>
              ))}
            </div>
          </SettingRow>
        )}
        {sec === 'in' && avgLate != null && avgLate > 5 && (
          <SettingRow title="Ahogy valójában fizet" sub="Billingo-számlák és banki tények alapján">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                padding: '14px 18px',
                borderRadius: R.lg,
                background: C.negBg,
                border: `1px solid #F3D9D3`,
                flexWrap: 'wrap',
              }}
            >
              <b style={{ font: `800 26px ${FONT_H}`, color: C.neg, whiteSpace: 'nowrap' }}>+{Math.round(avgLate)} nap</b>
              <span style={{ flex: '1 1 240px', font: `400 14px/1.45 ${FONT}`, color: C.ink }}>
                átlagos késés a határidőhöz képest. Javaslat: a cashflow-tervben számolj <b>{suggestDays} nappal</b>.
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('inv');
                    setN(String(suggestDays));
                    save('inv', String(suggestDays));
                  }}
                  style={{ border: 0, borderRadius: 999, background: C.navy, color: '#fff', padding: '10px 18px', font: `600 14px ${FONT}`, cursor: 'pointer' }}
                >
                  Tervezés tényleges késéssel
                </button>
              )}
            </div>
          </SettingRow>
        )}
        {canEdit && (
          <SettingRow title="Meglévő tervek">
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', font: `500 14.5px ${FONT}`, color: C.ink, cursor: 'pointer' }}>
              <input type="checkbox" checked={resched} onChange={(e) => setResched(e.target.checked)} style={{ width: 18, height: 18, accentColor: C.blue }} />A
              nyitott rendszeres tervek átütemezése is <span style={{ color: C.muted }}>({moved.length} változik)</span>
            </label>
          </SettingRow>
        )}
        {sec === 'out' && normalizeText(ix.groupById[L?.group_id || '']?.label || '').includes('alvallalkoz') && (
          <SettingRow title="Elszámoló tábla">
            <SheetLink leafId={leafId} />
          </SettingRow>
        )}
      </>
    );
  return (
    <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <b style={{ font: `700 14px ${FONT}`, color: sec === 'in' ? C.blueDark : C.navy }}>
        {sec === 'in' ? 'Vevőként (bevétel)' : 'Szállítóként (kiadás)'} · {displayGroup(ix.groupById[L?.group_id || '']?.label || '')}
      </b>
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
        Jelenleg:{' '}
        {payRuleLabel(rule || null) === 'nincs szabály'
          ? `számla + ${L?.pay_days ?? payDefaults(data.settings, sec).payDays} nap (alapértelmezett)`
          : payRuleLabel(rule)}
      </span>
      <select
        value={mode}
        disabled={!canEdit}
        onChange={(e) => {
          setMode(e.target.value);
          save(e.target.value);
        }}
        style={{
          ...inputStyle,
          height: 42,
          alignSelf: 'flex-start',
          maxWidth: '100%',
          border: `1.5px solid ${C.blue}`,
          font: `600 14px ${FONT}`,
          color: C.navy,
        }}
      >
        {TERM_MODES.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {(mode === 'inv' || mode === 'day') && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', font: `500 13.5px ${FONT}`, color: C.ink }}>
          {mode === 'inv' ? 'Fizetési határidő:' : 'A hónap napja:'}
          <input
            value={n}
            onChange={(e) => setN(e.target.value.replace(/\D/g, ''))}
            onBlur={() => save()}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            disabled={!canEdit}
            style={{ ...inputStyle, width: 70, height: 36, textAlign: 'center' }}
          />
          {mode === 'inv' ? 'nap a számlától' : '. nap (hétvégén az előző munkanap)'}
        </label>
      )}
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
        Következő esedékességek: {next.map((d) => d.replace(/-/g, '.') + '. ' + dayNameHu(d)).join(' · ')}
      </span>
      {sec === 'out' && normalizeText(ix.groupById[L?.group_id || '']?.label || '').includes('alvallalkoz') && <SheetLink leafId={leafId} />}
      {sec === 'in' && avgLate != null && avgLate > 5 && (
        // a tényleges fizetési szokás: átlagos késés a határidőhöz képest → javasolt tervezési nap (10-re kerekítve)
        <div style={{ background: C.bg, borderRadius: R.lg, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>Valójában átlag {Math.round(avgLate)} nap késéssel fizet</b>
          <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
            Javaslat: a cashflow-tervben számolj {Math.max(10, Math.round(((mode === 'inv' ? clamp('inv', n) : 8) + avgLate) / 10) * 10)} nappal.
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                const v = String(Math.max(10, Math.round(((mode === 'inv' ? clamp('inv', n) : 8) + avgLate) / 10) * 10));
                setMode('inv');
                setN(v);
                save('inv', v);
              }}
              style={{
                alignSelf: 'flex-start',
                marginTop: 4,
                border: 0,
                borderRadius: 999,
                background: C.navy,
                color: '#fff',
                padding: '9px 18px',
                font: `600 13.5px ${FONT}`,
                cursor: 'pointer',
              }}
            >
              Tervezés tényleges késéssel
            </button>
          )}
        </div>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', font: `500 13px ${FONT}`, color: C.ink, cursor: 'pointer' }}>
            <input type="checkbox" checked={resched} onChange={(e) => setResched(e.target.checked)} />a {open.length} nyitott rendszeres terv átütemezése is (
            {moved.length} változik)
          </label>
          <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>A változás azonnal mentődik.</span>
        </div>
      )}
    </div>
  );
}

/** Alvállalkozó elszámoló táblája (kötelező): Google Sheet link + betöltés – ebből számol a program projektenként. */
function SheetLink({ leafId }: { leafId: string }) {
  const { ix, data, run, canEdit, isAdmin, showToast } = useStore();
  const L = ix.leafById[leafId];
  const emp = (data.employees || []).find((e) => e.cost_leaf_id === leafId);
  const [url, setUrl] = useState(emp?.sheet_url || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrl(emp?.sheet_url || ''), [emp?.sheet_url]);
  const key = emp?.key || partnerIdOf(L?.label || '');
  const bad = !!url.trim() && !sheetIdOf(url.trim());
  const save = () => {
    const v = url.trim();
    if (bad || v === (emp?.sheet_url || '')) return;
    run(
      () => api('/api/employees', { method: 'PUT', body: { key, name: emp?.name || L?.label, cost_leaf_id: leafId, sheet_url: v } }),
      `${L?.label}: elszámoló tábla ${v ? 'mentve' : 'törölve'}`,
    );
  };
  const load = async () => {
    setBusy(true);
    try {
      const r = await api<{ xlsx: string }>('/api/worktime/fetch', { body: { employee: key } });
      const bin = atob(r.xlsx);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      await importWorkbook({ key, name: emp?.name || L?.label || '', cost_leaf_id: leafId }, buf.buffer, run, showToast);
    } catch (e: any) {
      showToast({ msg: e.message || 'Nem sikerült betölteni a táblát.', error: true });
    } finally {
      setBusy(false);
    }
  };
  const missing = !emp?.sheet_url;
  return (
    <div style={{ borderTop: `1px solid ${C.line3}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <b style={{ font: `700 13.5px ${FONT}`, color: missing ? C.neg : C.navy }}>
        Elszámoló tábla (XLS / Google-táblázat) <span style={{ color: C.neg }}>*</span>
        {missing && <span style={{ font: `600 12px ${FONT}`, color: C.neg }}> – kötelező, még nincs megadva</span>}
      </b>
      <span style={{ font: `500 12.5px/1.45 ${FONT}`, color: C.muted }}>
        Ebből számolja a program havonta, melyik projekten mennyi munka volt. A táblát „Bárki, akinek megvan a link” – Megtekintő megosztásra kell állítani.
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          disabled={!canEdit || !isAdmin}
          placeholder="https://docs.google.com/spreadsheets/d/…"
          style={{ ...inputStyle, flex: '1 1 320px', height: 36, borderColor: bad || missing ? C.neg : undefined }}
        />
        {emp?.sheet_url && isAdmin && (
          <Pill small onClick={load}>
            {busy ? 'Betöltés…' : 'Betöltés most'}
          </Pill>
        )}
        {emp?.sheet_url && (
          <a href={emp.sheet_url} target="_blank" rel="noreferrer" style={{ font: `600 12.5px ${FONT}`, color: C.blueDark }}>
            Megnyitás ↗
          </a>
        )}
      </div>
      {bad && <span style={{ font: `600 12px ${FONT}`, color: C.neg }}>Ez nem Google-táblázat link.</span>}
    </div>
  );
}

/** Tervezett feladatok: mit számlázunk a partnernek / mit fizetünk neki (havidíj, SEO, weboldal részlet…). */
export function PlannedTasks({ p, onEdit }: { p: PartnerStat; onEdit: (leaf: string, key?: string) => void }) {
  const { ix, data, canEdit, run, commit } = useStore();
  const byName = new Map<
    string,
    {
      name: string;
      sec: Section;
      next: string;
      n: number;
      sum: number;
      offer: boolean;
      ids: string[];
      offer_at: number | null;
      leaf: string;
      key: string;
      ms: string[];
    }
  >();
  for (const e of p.future) {
    const sec = ix.sectionOf(e.leaf_id);
    // sorozatonként külön sor (így a duplán betervezett, azonos nevű sorozatok is látszanak)
    const k = sec + '|' + e.leaf_id + '|' + (e.series_id || e.name) + '|' + (e.tentative ? 'o' : 'p');
    const x = byName.get(k) || {
      name: e.name || '(név nélkül)',
      sec,
      next: e.date,
      n: 0,
      sum: 0,
      offer: !!e.tentative,
      ids: [],
      offer_at: null,
      leaf: e.leaf_id,
      key: e.series_id || rowKey(e),
      ms: [],
    };
    x.n++;
    x.ms.push((e.period || e.date).slice(0, 7));
    x.sum += Math.abs(e.amount);
    x.ids.push(e.id);
    if (e.offer_at && (!x.offer_at || e.offer_at < x.offer_at)) x.offer_at = e.offer_at;
    if (e.date < x.next) x.next = e.date;
    byName.set(k, x);
  }
  const rows = [...byName.values()].sort((a, b) => a.next.localeCompare(b.next));
  // ajánlatok elfogadása ennél a partnernél: elfogadott / elutasított (törölt), arány, átlagos döntési idő
  const leafIds = new Set(p.leaves.map((l) => l.id));
  const st = offerConversion(
    data.entries.filter((e) => leafIds.has(e.leaf_id)),
    (data.lostOffers || []).filter((e) => leafIds.has(e.leaf_id)),
    data.today,
  );
  const accept = (r: (typeof rows)[number]) => {
    const ids = new Set(r.ids);
    run(
      () =>
        acceptOffer(
          ix,
          data.entries.filter((e) => ids.has(e.id)),
          data.series,
        ),
      `Ajánlat elfogadva: ${r.name} – bekerült a havi tervbe`,
    );
  };
  const reject = (r: (typeof rows)[number]) => {
    if (!confirm(`„${r.name}” ajánlat elutasítva? (${r.n} tétel kikerül a tervből, lezárt ajánlatként áthúzva látszik, az elfogadási arányba beszámít)`))
      return;
    commit({ delete: r.ids, rejected: true }, `Ajánlat elutasítva: ${r.name} – lezárva`);
  };
  const ago = (ms: number | null) => (ms ? Math.max(0, Math.round((Date.now() - ms) / 86400000)) : null);
  return (
    <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={eyebrow}>
        {
          {
            vevo: 'Tervezett feladatok – mit számlázunk',
            szallito: 'Tervezett kiadások – mit fizetünk',
            mindketto: 'Tervezett feladatok – mit számlázunk / mit fizetünk',
          }[kindOf(p, ix.sectionOf)]
        }
      </span>
      {rows.length ? (
        rows.map((r) => (
          <div
            key={r.leaf + r.key + r.offer}
            style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 6 }}
          >
            <span
              role="button"
              title="Tétel szerkesztése"
              onClick={() => canEdit && onEdit(r.leaf, r.key)}
              style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', cursor: canEdit ? 'pointer' : 'default' }}
            >
              <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>
                {r.name}
                {r.offer && <span style={{ font: `600 11px ${FONT}`, color: C.blue }}> · ajánlat</span>}
              </b>
              <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                {r.sec === 'in' ? 'számlázunk' : 'fizetünk'} · következő {dd(r.next)} · {r.n} alkalom
                {r.n > 1
                  ? ` (${[...new Set(r.ms)]
                      .sort()
                      .map((m) => monthLabel(m) + (m.slice(0, 4) !== ix.cur.slice(0, 4) ? ' ' + m.slice(0, 4) : ''))
                      .join(', ')})`
                  : ''}
                {r.offer && ago(r.offer_at) !== null ? ` · ${ago(r.offer_at)} napja nyitott ajánlat` : ''}
              </span>
            </span>
            {r.offer && canEdit && (
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', font: `600 13px ${FONT}`, color: C.inc, cursor: 'pointer' }}>
                  <input type="checkbox" checked={false} onChange={() => accept(r)} style={{ width: 18, height: 18, cursor: 'pointer' }} />
                  Elfogadva
                </label>
                <Pill small onClick={() => reject(r)}>
                  Elutasítva
                </Pill>
              </span>
            )}
            <b style={{ font: `700 13.5px ${FONT}`, color: r.sec === 'in' ? C.blueDark : C.navy, fontVariantNumeric: 'tabular-nums' }}>
              {r.sec === 'in' ? '+' : '−'}
              {fmt(r.sum)}
            </b>
            {canEdit && (
              <Pill small onClick={() => onEdit(r.leaf, r.key)}>
                Szerkesztés
              </Pill>
            )}
          </div>
        ))
      ) : (
        <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>Még nincs betervezett feladat ennél a partnernél.</span>
      )}
      <RejectedOffers leafIds={p.leaves.map((l) => l.id)} showLeaf={p.leaves.length > 1} />
      {(st.wonN > 0 || st.lostN > 0 || st.open.length + st.expired.length > 0) && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 8 }}>
          {[
            ['Ajánlat-elfogadás', st.rate === null ? '–' : `${Math.round(st.rate * 100)}%`],
            ['Elfogadva', `${st.wonN} db · ${fmt(st.wonSum)}`],
            ['Elutasítva', `${st.lostN} db · ${fmt(st.lostSum)}`],
            ['Nyitott', `${st.open.length + st.expired.length} db`],
            ['Elfogadásig átlag', st.acceptDays === null ? '–' : `${st.acceptDays} nap`],
            ['Elutasításig átlag', st.rejectDays === null ? '–' : `${st.rejectDays} nap`],
          ].map(([k, v]) => (
            <span key={k} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted }}>{k}</span>
              <b style={{ font: `700 14px ${FONT}`, color: C.navy }}>{v}</b>
            </span>
          ))}
        </div>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {p.leaves.map((l) => (
            <Pill key={l.id} small kind="primary" onClick={() => onEdit(l.id)}>
              {ix.sectionOf(l.id) === 'in' ? 'Számlázandó feladatok' : 'Fizetendő tételek'} · {displayGroup(ix.groupById[l.group_id]?.label || '')} –
              szerkesztés / új
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}

export function PartnerCardHost({ mobile }: { mobile?: boolean }) {
  const { partnerCard, openPartner, ix } = useStore();
  const all = useAllPartners();
  const [task, setTask] = useState<{ leaf: string; key?: string } | null>(null);
  const taskLeaf = task?.leaf ?? null;
  useEffect(() => {
    if (!partnerCard || taskLeaf) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openPartner(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [partnerCard, taskLeaf, openPartner]);
  if (!partnerCard) return null;
  const key = ix.leafById[partnerCard] ? partnerIdOf(ix.leafById[partnerCard].label) : partnerCard;
  const p = all.find((x) => x.key === key);
  const close = () => openPartner(null);
  if (task) return <PartnerModal leaf={task.leaf} edit={task.key ? { key: task.key } : null} onClose={() => setTask(null)} />;
  // mobilon teljes képernyős adatlap: lejárt · átl. késés · 12 hó, következő tétel, előzmények, „hogyan fizet?” naptár
  if (mobile && p) return <MobilePartnerScreen p={p} onClose={close} onNewItem={(leaf) => setTask({ leaf })} onEditItem={(leaf) => setTask({ leaf })} />;
  return (
    <Modal onClose={close} width={1180}>
      {p ? (
        <PartnerSheet
          p={p}
          onClose={close}
          onNewItem={(leaf) => setTask({ leaf })}
          onEditItem={(leaf, key) => setTask({ leaf, key })}
          onRenamed={(k) => openPartner(k)}
        />
      ) : (
        <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ flex: 1, margin: 0, font: `700 26px/1.15 ${FONT_H}`, color: C.navy }}>Ismeretlen partner</h2>
          <Pill small onClick={close}>
            Bezár
          </Pill>
        </div>
      )}
    </Modal>
  );
}

/** A partner neve a fejlécben; a ceruzára kattintva helyben átírható (Enter / kilépés = mentés, Esc = mégse). */
export function PartnerTitle({ p, mobile, onSaved }: { p: PartnerStat; mobile?: boolean; onSaved: (key: string) => void }) {
  const { canEdit, run } = useStore();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(p.name);
  const font = `700 ${mobile ? 22 : 26}px/1.15 ${FONT_H}`;
  const save = () => {
    setEdit(false);
    const n = v.replace(/\s+/g, ' ').trim();
    if (!n || n === p.name) return setV(p.name);
    run(async () => {
      const r = await api<{ key: string }>(`/api/partners/${encodeURIComponent(p.key)}`, { method: 'PUT', body: { name: n } });
      onSaved(r.key);
    }, `Partner átnevezve: ${n}`);
  };
  if (edit)
    return (
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(p.name);
            setEdit(false);
          }
        }}
        style={{ ...inputStyle, margin: '2px 0 0', height: mobile ? 40 : 46, font, color: C.navy, width: '100%', maxWidth: 560 }}
      />
    );
  return (
    <h2 style={{ margin: '2px 0 0', font, color: C.navy, display: 'flex', alignItems: 'center', gap: 8 }}>
      {p.name}
      {canEdit && (
        <button
          type="button"
          title="Név átírása"
          onClick={() => {
            setV(p.name);
            setEdit(true);
          }}
          style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.muted, font: `500 18px ${FONT}`, padding: 4 }}
        >
          ✎
        </button>
      )}
    </h2>
  );
}

/** Kattintható partnernév: bárhol a partner adatlapját nyitja. */
export function PartnerLink({ leaf, children, style }: { leaf: string; children: ReactNode; style?: CSSProperties }) {
  const { openPartner } = useStore();
  return (
    <span
      role="button"
      tabIndex={0}
      title="Partner adatlapja"
      onClick={(ev) => {
        ev.stopPropagation();
        openPartner(leaf);
      }}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ev.stopPropagation();
          openPartner(leaf);
        }
      }}
      className="partner-link"
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </span>
  );
}

/** Partnertörzs: az összes partner (vevő, szállító) egy helyen – név, típus, alternatív nevek, projektek szerkesztése. */
export function PartnerRegistry({ mobile, page }: { mobile?: boolean; page?: boolean }) {
  const { ix, data, openPartner, canEdit } = useStore();
  const all = useAllPartners();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'vevo' | 'szallito'>('all');
  const [open, setOpen] = useState<string | null>(null);
  // aktív partnerek: volt tranzakciója a választott időszakban, vagy van nyitott jövőbeli terve (alapból az elmúlt 3 hónap)
  const [period, setPeriod] = useState(3);
  const [sortBy, setSortBy] = useState<'name' | 'amount'>('name');
  const [sel, setSel] = useState<string | null>(null);
  const [how, setHow] = useState(false);
  const [newP, setNewP] = useState(false);
  const nq = normalizeText(q);
  const activity = useMemo(() => {
    const since = period ? addMonths(data.today.slice(0, 7), -period) + '-01' : '';
    const m = new Map<string, { sum: number; signed: number; n: number; open: boolean }>();
    for (const e of data.entries) {
      const x = m.get(e.leaf_id) || { sum: 0, signed: 0, n: 0, open: false };
      if (e.kind === 'actual' && e.date >= since && e.date <= data.today) {
        x.sum += Math.abs(e.amount);
        x.signed += ix.sectionOf(e.leaf_id) === 'in' ? Math.abs(e.amount) : -Math.abs(e.amount);
        x.n++;
      } else if (e.kind === 'plan' && !e.done && e.date >= data.today) x.open = true;
      m.set(e.leaf_id, x);
    }
    return m;
  }, [data.entries, data.today, period, ix]);
  const actOf = (p: (typeof all)[number]) =>
    p.leaves.reduce(
      (a, l) => {
        const x = activity.get(l.id);
        return x ? { sum: a.sum + x.sum, signed: a.signed + x.signed, n: a.n + x.n, open: a.open || x.open } : a;
      },
      { sum: 0, signed: 0, n: 0, open: false },
    );
  const list = all
    .filter((p) => !p.leaves.every((l) => l.archived))
    .filter((p) => {
      if (!period || nq) return true;
      const a = actOf(p);
      return a.n > 0 || a.open;
    })
    .filter((p) => {
      const k = kindOf(p, ix.sectionOf);
      return kind === 'all' || k === kind || k === 'mindketto';
    })
    .filter((p) => !nq || normalizeText([p.name, ...(p.info?.aliases || []), ...p.billingNames.map((b) => b.name)].join(' ')).includes(nq))
    .sort((a, b) => (sortBy === 'amount' ? actOf(b).sum - actOf(a).sum : 0) || a.name.localeCompare(b.name, 'hu'));
  // asztali Partnertörzs oldal (látványterv): táblázat + jobb oldali gyors szerkesztő, ↑/↓ = előző / következő partner
  const selKey = sel && list.some((p) => p.key === sel) ? sel : list[0]?.key || null;
  const selP = list.find((p) => p.key === selKey) || null;
  useEffect(() => {
    if (!page || mobile) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      const i = list.findIndex((p) => p.key === selKey);
      const n = list[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (n) {
        e.preventDefault();
        setSel(n.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (page && !mobile) {
    const signed12 = (p: (typeof all)[number]) => (p.sides.in?.last12 || 0) - (p.sides.out?.last12 || 0);
    const money = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
    const COLS = 'minmax(0,1.7fr) 96px minmax(0,1.2fr) 110px 100px 60px';
    const th: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted };
    const subOf = (p: (typeof all)[number]) => [...new Set([...(p.info?.aliases || []), ...p.billingNames.map((b) => b.name)])].filter((x) => x !== p.name);
    const selK = selP ? kindOf(selP, ix.sectionOf) : null;
    const selA = selP ? actOf(selP) : null;
    return (
      <div style={{ padding: '24px 28px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0, font: `800 32px/1.05 ${FONT_H}`, color: C.navy }}>Partnertörzs</h1>
            <p style={{ margin: '8px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted }}>
              Minden vevő és szállító egy helyen · a felismert nevek alapján párosítjuk és összevonjuk a banki, NAV- és Billingo-tételeket ·{' '}
              <button
                onClick={() => setHow(!how)}
                style={{ border: 0, background: 'transparent', padding: 0, color: C.blueDark, font: `600 14px ${FONT}`, cursor: 'pointer' }}
              >
                Hogyan működik?
              </button>
            </p>
            {how && (
              <p style={{ margin: '8px 0 0', font: `400 13px/1.5 ${FONT}`, color: C.muted, maxWidth: '90ch' }}>
                A felismert nevek (cégnév, Billingo-számlanév, banki név, üzlet/kút neve) alapján a rendszer a banki, NAV- és Billingo-tételeket a partnerhez
                párosítja és összevonja (pl. „Tankolás”: OMV 135, Shell 27, OMV 85). A partner nevére kattintva bárhol ugyanez az adatlap nyílik meg.
              </p>
            )}
          </div>
          {canEdit && (
            <button
              type="button"
              className="hov-primary"
              onClick={() => setNewP(true)}
              style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '12px 22px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
            >
              + Új partner
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Seg
            value={kind}
            onChange={setKind}
            options={[
              ['all', 'Mind'],
              ['vevo', 'Vevők'],
              ['szallito', 'Szállítók'],
            ]}
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Keresés névben, felismert névben…"
            aria-label="Partner keresése névben, felismert névben"
            style={{ ...inputStyle, height: 42, width: 380, borderRadius: 999, padding: '0 18px' }}
          />
          <select
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value))}
            style={{ ...inputStyle, height: 42, width: 220, borderRadius: 999, font: `600 14px ${FONT}`, color: C.navy }}
          >
            <option value={1}>Aktív: elmúlt 1 hónap</option>
            <option value={3}>Aktív: elmúlt 3 hónap</option>
            <option value={6}>Aktív: elmúlt 6 hónap</option>
            <option value={12}>Aktív: elmúlt 12 hónap</option>
            <option value={0}>Mind (inaktívak is)</option>
          </select>
          <span style={{ marginLeft: 'auto', font: `400 13.5px ${FONT}`, color: C.muted }}>
            {list.length} partner{period ? ` · tranzakció az elmúlt ${period} hónapban vagy nyitott terv` : ''}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.65fr) minmax(360px,1fr)', gap: 16, alignItems: 'start' }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '12px 18px', borderBottom: `1px solid ${C.line}` }}>
              <button
                onClick={() => setSortBy('name')}
                style={{
                  ...th,
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: sortBy === 'name' ? C.navy : C.muted,
                }}
              >
                Partner {sortBy === 'name' ? '↓' : ''}
              </button>
              <span style={th}>Típus</span>
              <span style={th}>Kategória</span>
              <button
                onClick={() => setSortBy('amount')}
                style={{
                  ...th,
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  textAlign: 'right',
                  cursor: 'pointer',
                  color: sortBy === 'amount' ? C.navy : C.muted,
                }}
              >
                12 hó {sortBy === 'amount' ? '↓' : ''}
              </button>
              <span style={{ ...th, textAlign: 'right' }}>{period || 12} hó</span>
              <span style={{ ...th, textAlign: 'right' }}>Tétel</span>
            </div>
            <div style={{ maxHeight: 'calc(100vh - 250px)', overflowY: 'auto' }}>
              {list.map((p) => {
                const k = kindOf(p, ix.sectionOf);
                const a = actOf(p);
                const subs = subOf(p);
                const on = p.key === selKey;
                const v12 = signed12(p);
                return (
                  <div
                    key={p.key}
                    onClick={() => setSel(p.key)}
                    role="button"
                    tabIndex={0}
                    aria-pressed={on}
                    aria-label={`${p.name} kiválasztása`}
                    onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), setSel(p.key))}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: COLS,
                      gap: 12,
                      alignItems: 'center',
                      padding: '10px 18px 10px 15px',
                      borderTop: `1px solid ${C.line3}`,
                      borderLeft: `3px solid ${on ? C.blue : 'transparent'}`,
                      background: on ? C.bg2 : '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <b style={{ font: `600 15px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</b>
                        {!subs.length && (
                          <span style={{ flex: 'none', padding: '1px 8px', borderRadius: 999, background: C.negBg, color: C.neg, font: `600 11px ${FONT}` }}>
                            nincs felismert név
                          </span>
                        )}
                      </span>
                      <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {subs.join(' · ') || '—'}
                      </span>
                    </span>
                    <span>
                      <span
                        style={{
                          padding: '3px 10px',
                          borderRadius: 999,
                          background: k === 'szallito' ? C.bg : C.bg2,
                          color: k === 'szallito' ? C.muted : C.blueDark,
                          font: `600 12px ${FONT}`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {KIND_LABEL[k]}
                      </span>
                    </span>
                    <span style={{ font: `400 13.5px ${FONT}`, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[...new Set(p.leaves.map((l) => displayGroup(ix.groupById[l.group_id]?.label || '')))].join(', ')}
                    </span>
                    <b
                      style={{
                        textAlign: 'right',
                        font: `700 14.5px ${FONT}`,
                        color: v12 > 0 ? C.inc : v12 < 0 ? C.navy : C.faint,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {v12 ? money(v12) : '–'}
                    </b>
                    <span style={{ textAlign: 'right', font: `500 14px ${FONT}`, color: a.signed ? C.ink : C.faint, fontVariantNumeric: 'tabular-nums' }}>
                      {a.signed ? money(a.signed) : '–'}
                    </span>
                    <span style={{ textAlign: 'right', font: `500 14px ${FONT}`, color: a.n ? C.ink : C.faint }}>{a.n || '–'}</span>
                  </div>
                );
              })}
              {!list.length && <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Nincs találat.</div>}
            </div>
          </div>

          {selP && (
            <div style={{ ...card, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 32px)' }}>
              <div style={{ padding: '18px 22px 14px', borderBottom: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ display: 'block', font: `800 24px/1.15 ${FONT_H}`, color: C.navy }}>{selP.name}</b>
                    <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
                      {selK ? KIND_LABEL[selK] : ''} ·{' '}
                      {selP.leaves
                        .map((l) => `${ix.sectionOf(l.id) === 'in' ? 'Bevétel' : 'Kiadás'} › ${displayGroup(ix.groupById[l.group_id]?.label || '')}`)
                        .join(', ')}
                    </span>
                  </div>
                  <Pill small onClick={() => openPartner(selP.key)}>
                    Teljes adatlap ›
                  </Pill>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {(
                    [
                      ['12 hó', signed12(selP)],
                      [`${period || 12} hó · ${selA?.n || 0} tétel`, selA?.signed || 0],
                    ] as [string, number][]
                  ).map(([l, v]) => (
                    <div
                      key={l}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '10px 14px',
                        borderRadius: R.lg,
                        background: C.bg,
                      }}
                    >
                      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>{l}</span>
                      <b style={{ font: `800 19px ${FONT_H}`, color: v > 0 ? C.inc : C.navy, fontVariantNumeric: 'tabular-nums' }}>{v ? money(v) : '–'}</b>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ padding: '0 22px', overflowY: 'auto', flex: 1 }}>
                <PartnerEditor key={selP.key + (selP.info?.updated_at || 0)} p={selP} part="panel" onSaved={(nk) => setSel(nk)} onPick={(k) => setSel(k)} />
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 22px',
                  borderTop: `1px solid ${C.line}`,
                  font: `400 12.5px ${FONT}`,
                  color: C.muted,
                }}
              >
                <i style={{ width: 8, height: 8, borderRadius: 999, background: C.blue, display: 'inline-block' }} />
                Automatikusan mentve · ↑/↓ előző / következő partner
              </div>
            </div>
          )}
        </div>
        {newP && <PartnerModal onClose={() => setNewP(false)} />}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Minden partner – vevő és szállító – egy helyen. Az <b>alternatív nevek</b> (cégnév, Billingo-számlanév, banki név, üzlet/kút neve) alapján a rendszer a
        banki, NAV- és Billingo-tételeket a partnerhez párosítja és összevonja (pl. „Tankolás”: OMV 135, Shell 27, OMV 85). A partner nevére kattintva bárhol
        ugyanez az adatlap nyílik meg.
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg
          value={kind}
          onChange={setKind}
          options={[
            ['all', 'Mind'],
            ['vevo', 'Vevők'],
            ['szallito', 'Szállítók'],
          ]}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Keresés névben, alternatív névben…"
          style={{ ...inputStyle, height: 42, flex: '1 1 240px' }}
        />
        <select value={period} onChange={(e) => setPeriod(Number(e.target.value))} style={{ ...inputStyle, height: 42, width: 230 }}>
          <option value={1}>Aktív: elmúlt 1 hónap</option>
          <option value={3}>Aktív: elmúlt 3 hónap</option>
          <option value={6}>Aktív: elmúlt 6 hónap</option>
          <option value={12}>Aktív: elmúlt 12 hónap</option>
          <option value={0}>Mind (inaktívak is)</option>
        </select>
        <Seg
          value={sortBy}
          onChange={setSortBy}
          options={[
            ['name', 'Név szerint'],
            ['amount', 'Összeg szerint'],
          ]}
        />
      </div>
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
        {list.length} partner
        {period ? ` · tranzakció az elmúlt ${period} hónapban, vagy nyitott terv (keresésnél mind)` : ''}
      </span>
      {list.map((p) => {
        const k = kindOf(p, ix.sectionOf);
        const isOpen = open === p.key;
        return (
          <div key={p.key} style={{ ...card, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  role="button"
                  className="partner-link"
                  onClick={() => openPartner(p.key)}
                  style={{ font: `700 15px ${FONT}`, color: C.navy, cursor: 'pointer' }}
                >
                  {p.name}
                </span>
                <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                  {KIND_LABEL[k]} · {p.leaves.map((l) => displayGroup(ix.groupById[l.group_id]?.label || '')).join(', ')}
                  {p.info?.aliases?.length ? ` · más néven: ${p.info.aliases.join(', ')}` : ''}
                </span>
              </span>
              <span style={{ font: `600 12.5px ${FONT}`, color: C.blueDark, fontVariantNumeric: 'tabular-nums' }}>
                {p.sides.in ? `+${fmt(p.sides.in.last12)}` : ''}
                {p.sides.in && p.sides.out ? ' / ' : ''}
                {p.sides.out ? `−${fmt(p.sides.out.last12)}` : ''}
                {p.sides.in || p.sides.out ? ' · 12 hó' : ''}
              </span>
              {period > 0 && actOf(p).n > 0 && (
                <span style={{ font: `600 12px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {period} hó: {fmt(actOf(p).sum)} · {actOf(p).n} tétel
                </span>
              )}
              <Pill small kind={isOpen ? 'primary' : 'light'} onClick={() => setOpen(isOpen ? null : p.key)}>
                {isOpen ? 'Bezár' : 'Szerkesztés'}
              </Pill>
              <Pill small onClick={() => openPartner(p.key)}>
                Adatlap
              </Pill>
            </div>
            {isOpen && (
              <div style={{ borderTop: `1px solid ${C.line3}`, paddingTop: 10 }}>
                <PartnerEditor key={p.key + (p.info?.updated_at || 0)} p={p} compact={mobile} onSaved={(nk) => setOpen(nk)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
