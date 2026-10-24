// Partner adatlap: bárhonnan a partner nevére kattintva nyílik. Felül a partnertörzs adatai (név, típus, alternatív nevek,
// adószám, megjegyzés, projektek), alatta a tervezett feladatok (mit számlázunk neki / mit fizetünk neki), majd a statisztika.
// A PartnerEditor a partnertörzs oldalon is ugyanez.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { offerConversion } from '../../shared/insights';
import { fmt } from '../../shared/model';
import { partnerIdOf, partnerStats, type PartnerStat } from '../../shared/partners';
import type { Partner, Section } from '../../shared/types';
import { api } from './api';
import { rowKey } from './logic';
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

export function PartnerEditor({ p, onSaved, compact }: { p: PartnerStat; onSaved?: (key: string) => void; compact?: boolean }) {
  const { ix, data, run, canEdit } = useStore();
  const [name, setName] = useState(p.name);
  const [kind, setKind] = useState<Kind>(p.info?.kind || 'auto');
  const [aliases, setAliases] = useState<string[]>(p.info?.aliases || []);
  const [alias, setAlias] = useState('');
  const [tax, setTax] = useState(p.info?.tax_number || '');
  const [note, setNote] = useState(p.info?.note || '');
  const [addSec, setAddSec] = useState<Section | null>(null);
  const dirty =
    name.trim() !== p.name ||
    kind !== (p.info?.kind || 'auto') ||
    JSON.stringify(aliases) !== JSON.stringify(p.info?.aliases || []) ||
    tax !== (p.info?.tax_number || '') ||
    note !== (p.info?.note || '');
  const addAlias = (a: string) => {
    const s = a.replace(/\s+/g, ' ').trim();
    if (s.length < 2 || aliases.some((x) => normalizeText(x) === normalizeText(s))) return;
    setAliases([...aliases, s]);
    setAlias('');
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
  const save = () =>
    run(async () => {
      const r = await api<{ key: string }>(`/api/partners/${encodeURIComponent(p.key)}`, {
        method: 'PUT',
        body: { name: name.trim(), kind: kind === 'auto' ? null : kind, aliases, tax_number: tax, note },
      });
      onSaved?.(r.key);
    }, 'Partner mentve');
  const groupsOf = (sec: Section) => ix.groups.filter((g) => g.section === sec);
  const moveLeaf = (leafId: string, group_id: string) => run(() => api(`/api/leaves/${leafId}`, { method: 'PATCH', body: { group_id } }), 'Projekt módosítva');
  const addRole = (group_id: string) => run(() => api('/api/leaves', { body: { group_id, label: p.name } }), 'Hozzáadva').then(() => setAddSec(null));
  const sel = { ...inputStyle, height: 38, padding: '0 10px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 10 }}>
        <Field label="Partner neve (ez jelenik meg mindenhol)">
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} style={{ ...inputStyle, height: 42 }} />
        </Field>
        <Field label="Típus">
          <Seg
            small
            value={kind}
            onChange={(v) => canEdit && setKind(v)}
            options={[
              ['auto', `Automatikus (${KIND_LABEL[kindOf(p, ix.sectionOf)]})`],
              ['vevo', 'Vevő'],
              ['szallito', 'Szállító'],
              ['mindketto', 'Mindkettő'],
            ]}
          />
        </Field>
      </div>

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
                  onClick={() => setAliases(aliases.filter((x) => x !== a))}
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
          <input value={tax} onChange={(e) => setTax(e.target.value)} disabled={!canEdit} placeholder="12345678-2-13" style={{ ...inputStyle, height: 40 }} />
        </Field>
        <Field label="Megjegyzés">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={!canEdit}
            placeholder="kapcsolattartó, szerződés, egyéb"
            style={{ ...inputStyle, height: 40 }}
          />
        </Field>
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Pill kind="primary" disabled={!dirty || !name.trim()} onClick={save}>
            Mentés
          </Pill>
          {dirty && <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>Nem mentett változás</span>}
        </div>
      )}

      <Field label="Projektek – vevőként (bevétel) és szállítóként (kiadás)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {p.leaves.map((l) => {
            const sec = ix.sectionOf(l.id);
            return (
              <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ width: 150, font: `600 13px ${FONT}`, color: sec === 'in' ? C.blueDark : C.navy }}>
                  {sec === 'in' ? 'Vevő · bevétel' : 'Szállító · kiadás'}
                </span>
                <select value={l.group_id} disabled={!canEdit} onChange={(e) => moveLeaf(l.id, e.target.value)} style={{ ...sel, flex: '1 1 220px' }}>
                  {groupsOf(sec).map((g) => (
                    <option key={g.id} value={g.id}>
                      {displayGroup(g.label)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
          {canEdit && !addSec && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Pill small kind="light" onClick={() => setAddSec('in')}>
                + Vevőként (bevételi projekt)
              </Pill>
              <Pill small kind="light" onClick={() => setAddSec('out')}>
                + Szállítóként (kiadási projekt)
              </Pill>
            </div>
          )}
          {canEdit && addSec && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ font: `600 13px ${FONT}`, color: C.navy }}>{addSec === 'in' ? 'Bevételi projekt:' : 'Kiadási projekt:'}</span>
              <select defaultValue="" onChange={(e) => e.target.value && addRole(e.target.value)} style={{ ...sel, flex: '1 1 220px' }}>
                <option value="">Válassz…</option>
                {groupsOf(addSec)
                  .filter((g) => !p.leaves.some((l) => l.group_id === g.id))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {displayGroup(g.label)}
                    </option>
                  ))}
              </select>
              <Pill small onClick={() => setAddSec(null)}>
                Mégse
              </Pill>
            </div>
          )}
        </div>
      </Field>
    </div>
  );
}

/** Tervezett feladatok: mit számlázunk a partnernek / mit fizetünk neki (havidíj, SEO, weboldal részlet…). */
function PlannedTasks({ p, onEdit }: { p: PartnerStat; onEdit: (leaf: string, key?: string) => void }) {
  const { ix, data, canEdit, commit } = useStore();
  const byName = new Map<
    string,
    { name: string; sec: Section; next: string; n: number; sum: number; offer: boolean; ids: string[]; offer_at: number | null; leaf: string; key: string }
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
    };
    x.n++;
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
    commit({ upsert: data.entries.filter((e) => ids.has(e.id)).map((e) => ({ ...e, tentative: 0 })) }, `Ajánlat elfogadva: ${r.name}`);
  };
  const reject = (r: (typeof rows)[number]) => {
    if (!confirm(`„${r.name}” ajánlat elutasítva? (${r.n} tétel törlődik a tervből, az elutasítási arányba beszámít)`)) return;
    commit({ delete: r.ids }, `Ajánlat elutasítva: ${r.name}`);
  };
  const ago = (ms: number | null) => (ms ? Math.max(0, Math.round((Date.now() - ms) / 86400000)) : null);
  return (
    <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={eyebrow}>Tervezett feladatok – mit számlázunk / mit fizetünk</span>
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
      {(st.won.length > 0 || st.lost.length > 0 || st.open.length + st.expired.length > 0) && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 8 }}>
          {[
            ['Ajánlat-elfogadás', st.rate === null ? '–' : `${Math.round(st.rate * 100)}%`],
            ['Elfogadva', `${st.won.length} db · ${fmt(st.wonSum)}`],
            ['Elutasítva', `${st.lost.length} db · ${fmt(st.lostSum)}`],
            ['Nyitott', `${st.open.length + st.expired.length} db`],
            ['Elfogadásig átlag', st.acceptDays === null ? '–' : `${st.acceptDays} nap`],
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
  return (
    <Modal onClose={close} width={1000}>
      <div style={{ padding: mobile ? 16 : 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={eyebrow}>Partner adatlap{p ? ` · ${KIND_LABEL[kindOf(p, ix.sectionOf)]}` : ''}</span>
            <h2 style={{ margin: '2px 0 0', font: `700 ${mobile ? 22 : 26}px/1.15 ${FONT_H}`, color: C.navy }}>{p?.name || 'Ismeretlen partner'}</h2>
            {p && !!p.info?.aliases?.length && <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>más néven: {p.info.aliases.join(' · ')}</span>}
          </div>
          <Pill small onClick={close}>
            Bezár
          </Pill>
        </div>
        {p ? (
          <>
            <div style={{ ...card, padding: 14 }}>
              <PartnerEditor key={p.key + (p.info?.updated_at || 0)} p={p} compact={mobile} onSaved={(k) => openPartner(k)} />
            </div>
            <PlannedTasks p={p} onEdit={(leaf, key) => setTask({ leaf, key })} />
            <PartnerDetail p={p} mobile={mobile} embedded onBack={close} />
          </>
        ) : (
          <span style={{ font: `500 13.5px ${FONT}`, color: C.muted }}>Ehhez a névhez nem tartozik partner.</span>
        )}
      </div>
    </Modal>
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
  const { ix, openPartner } = useStore();
  const all = useAllPartners();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'vevo' | 'szallito'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const nq = normalizeText(q);
  const list = all
    .filter((p) => !p.leaves.every((l) => l.archived))
    .filter((p) => {
      const k = kindOf(p, ix.sectionOf);
      return kind === 'all' || k === kind || k === 'mindketto';
    })
    .filter((p) => !nq || normalizeText([p.name, ...(p.info?.aliases || []), ...p.billingNames.map((b) => b.name)].join(' ')).includes(nq))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'));
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
      </div>
      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>{list.length} partner</span>
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
