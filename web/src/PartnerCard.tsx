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
import { payDate, payRuleLabel } from '../../shared/workdays';
import { sheetIdOf } from '../../shared/worktime';
import { api } from './api';
import { importWorkbook } from './BreakevenView';
import { acceptOffer, payDefaults, rowKey } from './logic';
import { PartnerModal } from './PartnerModal';
import { PartnerDetail } from './PartnersView';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Modal, Pill, Seg, card, eyebrow, inputStyle } from './ui';

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
}: {
  p: PartnerStat;
  onSaved?: (key: string) => void;
  compact?: boolean;
  /** basic = név + típus (adatlap 1. fül), company = cégadatok + mappák (2. fül), all = minden (partnertörzs) */
  part?: 'basic' | 'company' | 'all';
}) {
  const { ix, data, run, canEdit } = useStore();
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
        borderRadius: 10,
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
          borderRadius: 12,
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
                    borderRadius: 8,
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
                              borderRadius: 6,
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

const TERM_MODES: [string, string][] = [
  ['inv', 'Számla a hónap 1. munkanapján + N nap'],
  ['day', 'Minden hónap adott napján'],
  ['first_workday', 'Hónap első munkanapja'],
  ['last_workday', 'Hónap utolsó munkanapja'],
];

/** Fizetési feltételek partnerenként (alkategóriánként): mikor esedékes a rendszeres tétel – a tervek ehhez igazodnak. */
function PaymentTerms({ p }: { p: PartnerStat }) {
  const { ix } = useStore();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ font: `500 13px/1.5 ${FONT}`, color: C.muted }}>
        Itt adod meg, hogy ennél a partnernél általában mikor esedékes a fizetés. Ez minden hónapban így ismétlődik: az új rendszeres tervek ehhez a naphoz
        kerülnek, és a meglévő nyitott terveket is átütemezheted.
      </span>
      {p.leaves.map((l) => (
        <TermRow key={l.id} leafId={l.id} sec={ix.sectionOf(l.id)} />
      ))}
    </div>
  );
}

function TermRow({ leafId, sec }: { leafId: string; sec: Section }) {
  const { ix, data, run, commit, canEdit } = useStore();
  const L = ix.leafById[leafId];
  const rule = L?.pay_rule || '';
  const init = (): [string, number] => {
    const inv = rule.match(/^inv:(\d+)$/);
    if (inv) return ['inv', Number(inv[1])];
    const d = rule.match(/^day:(\d+)$/);
    if (d) return ['day', Number(d[1])];
    if (rule === 'first_workday' || rule === 'last_workday') return [rule, 0];
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
      <Seg
        small
        value={mode}
        onChange={(v: string) => {
          if (!canEdit) return;
          setMode(v);
          save(v);
        }}
        options={TERM_MODES as any}
      />
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
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>Következő esedékességek: {next.map((d) => d.replace(/-/g, '.') + '.').join(' · ')}</span>
      {sec === 'out' && normalizeText(ix.groupById[L?.group_id || '']?.label || '').includes('alvallalkoz') && <SheetLink leafId={leafId} />}
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
function PlannedTasks({ p, onEdit }: { p: PartnerStat; onEdit: (leaf: string, key?: string) => void }) {
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
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', font: `600 13px ${FONT}`, color: '#1A7340', cursor: 'pointer' }}>
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
  const [tab, setTab] = useState<'main' | 'company' | 'terms'>('main');
  useEffect(() => setTab('main'), [partnerCard]);
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
  return (
    <Modal onClose={close} width={1000}>
      <div style={{ padding: mobile ? 16 : 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={eyebrow}>Partner adatlap{p ? ` · ${KIND_LABEL[kindOf(p, ix.sectionOf)]}` : ''}</span>
            {p ? (
              <PartnerTitle p={p} mobile={mobile} onSaved={(k) => openPartner(k)} />
            ) : (
              <h2 style={{ margin: '2px 0 0', font: `700 ${mobile ? 22 : 26}px/1.15 ${FONT_H}`, color: C.navy }}>Ismeretlen partner</h2>
            )}
            {p && !!p.info?.aliases?.length && <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>más néven: {p.info.aliases.join(' · ')}</span>}
          </div>
          <Pill small onClick={close}>
            Bezár
          </Pill>
        </div>
        {p ? (
          <>
            <div style={{ display: 'flex', gap: 6, borderBottom: `1px solid ${C.line2}`, flexWrap: 'wrap' }}>
              {(
                [
                  ['main', 'Áttekintés'],
                  ['company', 'Cégadatok'],
                  ['terms', 'Fizetési feltételek'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  style={{
                    border: 0,
                    background: 'transparent',
                    padding: '8px 14px',
                    font: `700 14px ${FONT}`,
                    color: tab === k ? C.navy : C.muted,
                    borderBottom: `3px solid ${tab === k ? C.blue : 'transparent'}`,
                    cursor: 'pointer',
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            {tab === 'main' && (
              <>
                <PlannedTasks p={p} onEdit={(leaf, key) => setTask({ leaf, key })} />
                <PartnerDetail p={p} mobile={mobile} embedded part="stats" onBack={close} onEditItem={(leaf, key) => setTask({ leaf, key })} />
              </>
            )}
            {tab === 'company' && (
              <>
                <div style={{ ...card, padding: 14 }}>
                  <PartnerEditor key={p.key + (p.info?.updated_at || 0)} p={p} part="company" compact={mobile} onSaved={(k) => openPartner(k)} />
                </div>
                <PartnerDetail p={p} mobile={mobile} embedded part="names" onBack={close} />
              </>
            )}
            {tab === 'terms' && <PaymentTerms p={p} />}
          </>
        ) : (
          <span style={{ font: `500 13.5px ${FONT}`, color: C.muted }}>Ehhez a névhez nem tartozik partner.</span>
        )}
      </div>
    </Modal>
  );
}

/** A partner neve a fejlécben; a ceruzára kattintva helyben átírható (Enter / kilépés = mentés, Esc = mégse). */
function PartnerTitle({ p, mobile, onSaved }: { p: PartnerStat; mobile?: boolean; onSaved: (key: string) => void }) {
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
      title="Partner adatlapja"
      onClick={(ev) => {
        ev.stopPropagation();
        openPartner(leaf);
      }}
      className="partner-link"
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </span>
  );
}

/** Partnertörzs: az összes partner (vevő, szállító) egy helyen – név, típus, alternatív nevek, projektek szerkesztése. */
export function PartnerRegistry({ mobile }: { mobile?: boolean }) {
  const { ix, data, openPartner } = useStore();
  const all = useAllPartners();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'vevo' | 'szallito'>('all');
  const [open, setOpen] = useState<string | null>(null);
  // aktív partnerek: volt tranzakciója a választott időszakban, vagy van nyitott jövőbeli terve (alapból az elmúlt 3 hónap)
  const [period, setPeriod] = useState(3);
  const [sortBy, setSortBy] = useState<'name' | 'amount'>('name');
  const nq = normalizeText(q);
  const activity = useMemo(() => {
    const since = period ? addMonths(data.today.slice(0, 7), -period) + '-01' : '';
    const m = new Map<string, { sum: number; n: number; open: boolean }>();
    for (const e of data.entries) {
      const x = m.get(e.leaf_id) || { sum: 0, n: 0, open: false };
      if (e.kind === 'actual' && e.date >= since && e.date <= data.today) {
        x.sum += Math.abs(e.amount);
        x.n++;
      } else if (e.kind === 'plan' && !e.done && e.date >= data.today) x.open = true;
      m.set(e.leaf_id, x);
    }
    return m;
  }, [data.entries, data.today, period]);
  const actOf = (p: (typeof all)[number]) =>
    p.leaves.reduce(
      (a, l) => {
        const x = activity.get(l.id);
        return x ? { sum: a.sum + x.sum, n: a.n + x.n, open: a.open || x.open } : a;
      },
      { sum: 0, n: 0, open: false },
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
