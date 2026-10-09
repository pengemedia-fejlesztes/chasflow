// Kategória / ügyfél választó: „+ Új” elöl, aktív ügyfelek csoportonként, gépelésre kiegészítő kereső.
import { useMemo, useState } from 'react';
import { displayGroup, normalizeText } from '../../shared/categories';
import { addMonths, endOfMonth } from '../../shared/model';
import type { Section } from '../../shared/types';
import { api } from './api';
import { useStore } from './store';
import { C, FONT, inputStyle } from './ui';

const chip = (active: boolean, big?: boolean): React.CSSProperties => ({
  flex: 'none',
  border: `1px solid ${active ? C.blue : C.line2}`,
  borderRadius: 999,
  padding: big ? '0 14px' : '6px 12px',
  height: big ? 38 : undefined,
  font: `600 ${big ? 13.5 : 12.5}px ${FONT}`,
  cursor: 'pointer',
  background: active ? C.blue : '#fff',
  color: active ? '#fff' : C.ink,
  whiteSpace: 'nowrap',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

/** Aktív kategóriák: van nyitott terve a következő 12 hónapban, vagy volt ténye az elmúlt 4 hónapban. */
export function useActiveLeaves(section: Section): Set<string> {
  const { data, ix } = useStore();
  return useMemo(() => {
    const from = addMonths(ix.cur, -4) + '-01';
    const to = endOfMonth(addMonths(ix.cur, 12));
    const s = new Set<string>();
    for (const e of data.entries) {
      if (ix.sectionOf(e.leaf_id) !== section) continue;
      if (e.kind === 'plan' ? !e.done && e.date >= ix.cur + '-01' && e.date <= to : e.date >= from) s.add(e.leaf_id);
    }
    return s;
  }, [data.entries, ix, section]);
}

export function LeafPicker({ section, value, onChange, big }: { section: Section; value: string | null; onChange: (id: string) => void; big?: boolean }) {
  const { ix, run, showToast, isAdmin } = useStore();
  const active = useActiveLeaves(section);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const defaultGroup =
    ix.groups.find((g) => g.section === section && (section === 'in' ? /projekt/i.test(g.label) : /m[űu]k[öo]d[ée]si/i.test(g.label)))?.id ||
    ix.groups.find((g) => g.section === section)?.id ||
    '';
  const [groupId, setGroupId] = useState(defaultGroup);
  const leaves = ix.leaves.filter((l) => !l.archived && ix.sectionOf(l.id) === section);
  const nq = normalizeText(q);
  const results = nq ? leaves.filter((l) => normalizeText(l.label + ' ' + (ix.groupById[l.group_id]?.label || '')).includes(nq)).slice(0, 14) : [];
  const exact = nq && leaves.some((l) => normalizeText(l.label) === nq);
  const groups = ix.groups.filter((g) => g.section === section);
  const newWord = section === 'in' ? 'ügyfél' : 'kategória';

  const create = async () => {
    const label = q.trim();
    if (!label) return showToast({ msg: `Add meg az új ${newWord} nevét.`, error: true });
    try {
      const r = await api<{ id: string }>('/api/leaves', { body: { group_id: groupId, label } });
      await run(async () => {}, `Új ${newWord}: ${label}`);
      onChange(r.id);
      setQ('');
      setCreating(false);
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  };

  const sel = value ? ix.leafById[value] : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setCreating(!creating)}
          style={{
            ...chip(creating, big),
            borderStyle: creating ? 'solid' : 'dashed',
            color: creating ? '#fff' : C.blueDark,
            background: creating ? C.navy : '#fff',
            borderColor: creating ? C.navy : C.blue,
          }}
        >
          + Új {newWord}
        </button>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={creating ? `Új ${newWord} neve…` : '🔍 Keresés…'}
          autoCapitalize="sentences"
          style={{ ...inputStyle, flex: '1 1 160px', height: big ? 38 : 32, borderRadius: 999, fontSize: big ? 15 : 12.5 }}
        />
        {sel && !creating && (
          <span style={{ ...chip(true, big), cursor: 'default' }} title={displayGroup(ix.groupById[sel.group_id]?.label || '')}>
            ✓ {sel.label}
          </span>
        )}
      </div>

      {creating && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: C.bg2, borderRadius: 12, padding: 10 }}>
          <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted }}>Melyik csoportba?</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {groups.map((g) => (
              <button key={g.id} type="button" onClick={() => setGroupId(g.id)} style={chip(groupId === g.id, big)}>
                {displayGroup(g.label)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={create}
            disabled={!q.trim()}
            style={{
              alignSelf: 'flex-start',
              height: big ? 42 : 34,
              border: 0,
              borderRadius: 999,
              background: C.navy,
              color: '#fff',
              padding: '0 18px',
              font: `600 14px ${FONT}`,
              opacity: q.trim() ? 1 : 0.5,
            }}
          >
            {q.trim() ? `„${q.trim()}” létrehozása` : `Írd be fent az új ${newWord} nevét`}
          </button>
        </div>
      )}

      {!creating && nq && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {results.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => {
                onChange(l.id);
                setQ('');
              }}
              style={chip(value === l.id, big)}
              title={displayGroup(ix.groupById[l.group_id]?.label || '')}
            >
              {l.label}
              <span style={{ opacity: 0.6, fontWeight: 500 }}> · {displayGroup(ix.groupById[l.group_id]?.label || '').replace(/^\d+ · /, '')}</span>
            </button>
          ))}
          {!exact && (
            <button type="button" onClick={() => setCreating(true)} style={{ ...chip(false, big), borderStyle: 'dashed', color: C.blueDark }}>
              + Új: „{q.trim()}”
            </button>
          )}
          {!results.length && <span style={{ font: `500 13px ${FONT}`, color: C.muted, alignSelf: 'center' }}>Nincs találat.</span>}
        </div>
      )}

      {!creating && !nq && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map((g) => {
            const ls = leaves.filter((l) => l.group_id === g.id && (active.has(l.id) || l.id === value));
            if (!ls.length) return null;
            return (
              <div key={g.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted }}>{displayGroup(g.label)}</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {ls.map((l) => (
                    <button key={l.id} type="button" onClick={() => onChange(l.id)} style={chip(value === l.id, big)}>
                      {value === l.id ? '✓ ' : ''}
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
            Csak az aktív {section === 'in' ? 'ügyfelek' : 'kategóriák'} látszanak (van tervük vagy friss forgalmuk). A többit a keresővel éred el
            {isAdmin ? '' : ''}.
          </span>
        </div>
      )}
    </div>
  );
}
