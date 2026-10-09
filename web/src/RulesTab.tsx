// Automatikus párosítások kezelése: mely partnerek / szövegek mely kategóriához tartoznak, és mi könyvelődik jóváhagyás nélkül.
import { useEffect, useMemo, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import type { Section } from '../../shared/types';
import { api } from './api';
import { LeafPicker } from './LeafPicker';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, Seg, card, inputStyle } from './ui';

interface ContainsRow {
  id: string;
  pattern: string;
  leaf_id: string;
  auto: number;
  note: string | null;
  source: string;
  hits: number;
}
interface LearnedRow {
  pattern: string;
  leaf_id: string;
  auto: number;
  hits: number;
}
type Row = { kind: 'contains'; r: ContainsRow } | { kind: 'learned'; r: LearnedRow };

const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button
    type="button"
    onClick={onClick}
    title="Automatikus könyvelés: jóváhagyás nélkül, a banki dátumra kerül a hónap tényei közé"
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      border: 0,
      background: 'transparent',
      cursor: 'pointer',
      font: `600 12.5px ${FONT}`,
      color: on ? C.blueDark : C.muted,
      padding: 0,
    }}
  >
    <span style={{ width: 34, height: 20, borderRadius: 999, background: on ? C.blue : C.line2, position: 'relative', transition: 'background .15s' }}>
      <i style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: 999, background: '#fff', transition: 'left .15s' }} />
    </span>
    {label}
  </button>
);

export function RulesTab() {
  const { ix, run, showToast, canEdit } = useStore();
  const [contains, setContains] = useState<ContainsRow[]>([]);
  const [learned, setLearned] = useState<LearnedRow[]>([]);
  const [q, setQ] = useState('');
  const [nr, setNr] = useState({ pattern: '', section: 'out' as Section, leaf: null as string | null, auto: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<Record<string, string>>({});

  const load = () =>
    api<{ contains: ContainsRow[]; learned: LearnedRow[] }>('/api/rules').then(
      (r) => {
        setContains(r.contains);
        setLearned(r.learned);
      },
      (e) => showToast({ msg: e.message, error: true }),
    );
  useEffect(() => {
    load();
  }, []);

  const act = async (fn: () => Promise<any>, msg: string) => {
    try {
      const r = await fn();
      await load();
      await run(
        async () => {},
        msg + (r?.auto ? ` · ${r.auto} tétel automatikusan könyvelve` : '') + (r?.updated ? ` · ${r.updated} várakozó tétel átsorolva` : ''),
      );
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };

  // kategóriánként csoportosítva
  const groups = useMemo(() => {
    const rows: Row[] = [...contains.map((r) => ({ kind: 'contains' as const, r })), ...learned.map((r) => ({ kind: 'learned' as const, r }))];
    const nq = normalizeText(q);
    const by = new Map<string, Row[]>();
    for (const row of rows) {
      const L = ix.leafById[row.r.leaf_id];
      if (!L) continue;
      const hay = normalizeText(row.r.pattern + ' ' + L.label + ' ' + (ix.groupById[L.group_id]?.label || ''));
      if (nq && !hay.includes(nq)) continue;
      if (!by.has(row.r.leaf_id)) by.set(row.r.leaf_id, []);
      by.get(row.r.leaf_id)!.push(row);
    }
    return [...by.entries()].sort((a, b) => {
      const la = ix.leafById[a[0]],
        lb = ix.leafById[b[0]];
      const ga = ix.groupById[la.group_id],
        gb = ix.groupById[lb.group_id];
      return (ga.section === gb.section ? 0 : ga.section === 'in' ? -1 : 1) || ga.sort - gb.sort || la.label.localeCompare(lb.label, 'hu');
    });
  }, [contains, learned, q, ix]);

  const autoCount = contains.filter((r) => r.auto).length + learned.filter((r) => r.auto).length;

  return (
    <>
      <div style={{ ...card, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>Automatikus párosítások</div>
          <div style={{ font: `400 13.5px/1.5 ${FONT}`, color: C.muted, marginTop: 4 }}>
            Itt látod, hogy a banki tételeket a rendszer milyen szöveg vagy partner alapján melyik kategóriába sorolja. Egy kategóriához több partner is
            tartozhat: például <b>Baka Aranka</b> számláját az <b>AssistSupport Kft.</b> állítja ki. Ha az <b>Automatikus könyvelés</b> be van kapcsolva, a
            tétel jóváhagyás nélkül kerül a banki dátum hónapjának tényei közé (pl. tranzakciós díj → Bank költség). Jelenleg {autoCount} automatikus szabály
            van.
          </div>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: C.bg, borderRadius: 12, padding: 12 }}>
            <span style={{ font: `700 13.5px ${FONT_H}`, color: C.navy }}>Új párosítás</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={nr.pattern}
                onChange={(e) => setNr({ ...nr, pattern: e.target.value })}
                placeholder="Partner neve vagy közlemény részlet (pl. AssistSupport)"
                style={{ ...inputStyle, flex: '1 1 260px' }}
              />
              <Seg
                small
                value={nr.section}
                onChange={(v) => setNr({ ...nr, section: v, leaf: null })}
                options={[
                  ['out', 'Kiadás'],
                  ['in', 'Bevétel'],
                ]}
              />
              <Toggle on={nr.auto} onClick={() => setNr({ ...nr, auto: !nr.auto })} label="Automatikus könyvelés" />
            </div>
            <LeafPicker key={nr.section} section={nr.section} value={nr.leaf} onChange={(id) => setNr({ ...nr, leaf: id })} />
            <div>
              <Pill
                kind="dark"
                disabled={!nr.pattern.trim() || !nr.leaf}
                onClick={() =>
                  act(
                    () => api('/api/rules', { body: { pattern: nr.pattern, leaf_id: nr.leaf, auto: nr.auto } }),
                    `Párosítás mentve: „${nr.pattern}” → ${ix.leafById[nr.leaf!]?.label}`,
                  ).then(() => setNr({ ...nr, pattern: '', leaf: null, auto: false }))
                }
              >
                Párosítás mentése
              </Pill>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="🔍 Szűrés partnerre vagy kategóriára…"
            style={{ ...inputStyle, flex: '1 1 240px' }}
          />
          {canEdit && (
            <Pill onClick={() => act(() => api('/api/rules/apply', { body: {} }), 'Szabályok alkalmazva a várakozó tételekre')}>
              ↻ Alkalmazás a várakozó tételekre
            </Pill>
          )}
        </div>
      </div>

      {groups.map(([leafId, rows]) => {
        const L = ix.leafById[leafId];
        const G = ix.groupById[L.group_id];
        return (
          <div key={leafId} style={{ ...card, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: G.section === 'in' ? C.blue : C.muted }}>
                {G.section === 'in' ? 'Bevétel' : 'Kiadás'} · {displayGroup(G.label)}
              </span>
              <span style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>{L.label}</span>
            </div>
            {rows.map((row) => {
              const key = row.kind + ':' + (row.kind === 'contains' ? row.r.id : row.r.pattern);
              const r = row.r;
              return (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${C.line3}`, paddingTop: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ font: `600 14px ${FONT}`, color: C.ink, flex: '1 1 200px' }}>
                      {row.kind === 'contains' ? `tartalmazza: „${r.pattern}”` : `partner: ${r.pattern}`}
                      <span style={{ font: `500 12px ${FONT}`, color: C.muted, marginLeft: 8 }}>
                        {row.kind === 'learned' ? 'tanult (jóváhagyásból)' : row.r.source === 'builtin' ? 'beépített' : 'kézi'} · {r.hits} találat
                        {row.kind === 'contains' && row.r.note ? ' · ' + row.r.note : ''}
                      </span>
                    </span>
                    {canEdit && (
                      <>
                        <Toggle
                          on={!!r.auto}
                          label="Automatikus könyvelés"
                          onClick={() =>
                            act(
                              () =>
                                row.kind === 'contains'
                                  ? api(`/api/rules/${row.r.id}`, { method: 'PATCH', body: { auto: !r.auto } })
                                  : api('/api/partner-rules', { method: 'PATCH', body: { pattern: r.pattern, auto: !r.auto } }),
                              !r.auto ? 'Automatikus könyvelés bekapcsolva' : 'Automatikus könyvelés kikapcsolva',
                            )
                          }
                        />
                        <Pill small onClick={() => setEditing(editing === key ? null : key)}>
                          {editing === key ? 'Mégse' : 'Áthelyezés'}
                        </Pill>
                        <Pill
                          small
                          kind="danger"
                          onClick={() =>
                            confirm('Törlöd ezt a párosítást?') &&
                            act(
                              () =>
                                row.kind === 'contains'
                                  ? api(`/api/rules/${row.r.id}`, { method: 'DELETE' })
                                  : api('/api/partner-rules', { method: 'DELETE', body: { pattern: r.pattern } }),
                              'Párosítás törölve',
                            )
                          }
                        >
                          Törlés
                        </Pill>
                      </>
                    )}
                  </div>
                  {editing === key && (
                    <div style={{ background: C.bg, borderRadius: 10, padding: 10 }}>
                      <LeafPicker
                        section={G.section}
                        value={r.leaf_id}
                        onChange={(id) => {
                          setEditing(null);
                          act(
                            () =>
                              row.kind === 'contains'
                                ? api(`/api/rules/${row.r.id}`, { method: 'PATCH', body: { leaf_id: id } })
                                : api('/api/partner-rules', { method: 'PATCH', body: { pattern: r.pattern, leaf_id: id } }),
                            `Áthelyezve: ${ix.leafById[id]?.label}`,
                          );
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, borderTop: `1px solid ${C.line3}`, paddingTop: 8 }}>
                <input
                  value={addFor[leafId] || ''}
                  onChange={(e) => setAddFor({ ...addFor, [leafId]: e.target.value })}
                  placeholder={`+ további partner / szöveg ehhez: ${L.label}`}
                  style={{ ...inputStyle, flex: 1, height: 34 }}
                />
                <Pill
                  small
                  kind="light"
                  disabled={!(addFor[leafId] || '').trim()}
                  onClick={() =>
                    act(() => api('/api/rules', { body: { pattern: addFor[leafId], leaf_id: leafId } }), `Hozzáadva: „${addFor[leafId]}” → ${L.label}`).then(
                      () => setAddFor({ ...addFor, [leafId]: '' }),
                    )
                  }
                >
                  Hozzáad
                </Pill>
              </div>
            )}
          </div>
        );
      })}
      {groups.length === 0 && <div style={{ ...card, padding: 24, color: C.muted, font: `500 14px ${FONT}` }}>Nincs találat.</div>}
    </>
  );
}
