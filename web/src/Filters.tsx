// Szűrősáv: időszak, nézet (tény/terv), szekció, ajánlatok, becslés, keresés.
import { displayGroup } from '../../shared/categories';
import { addMonths, monthLong, type Filters } from '../../shared/model';
import { useStore } from './store';
import { C, FONT, Seg, inputStyle } from './ui';

export function presets(cur: string, firstActual: string | null) {
  const y = Number(cur.slice(0, 4));
  const fy = firstActual ? Number(firstActual.slice(0, 4)) : y - 1;
  const list: { key: string; label: string; f: Partial<Filters> }[] = [
    { key: 'n8', label: 'Következő 8 hónap', f: { from: cur, to: addMonths(cur, 7), granularity: 'month' } },
    { key: 'n12', label: 'Következő 12 hónap', f: { from: cur, to: addMonths(cur, 12), granularity: 'month' } },
    { key: 'p12', label: 'Elmúlt 12 hónap', f: { from: addMonths(cur, -12), to: cur, granularity: 'month' } },
    { key: 'ny', label: `${y + 1}. év (becslés)`, f: { from: `${y + 1}-01`, to: `${y + 1}-12`, granularity: 'month' } },
  ];
  for (let yy = y; yy >= fy; yy--) list.push({ key: 'y' + yy, label: `${yy}. év`, f: { from: `${yy}-01`, to: `${yy}-12`, granularity: 'month' } });
  list.push({ key: 'years', label: `Évek ${fy}–${y + 1}`, f: { from: `${fy}-01`, to: `${y + 1}-12`, granularity: 'year' } });
  return list;
}

export function periodLabel(f: Filters, cur: string, firstActual: string | null) {
  const p = presets(cur, firstActual).find((p) => p.f.from === f.from && p.f.to === f.to && p.f.granularity === f.granularity);
  return p ? p.label : `${monthLong(f.from)} – ${monthLong(f.to)}`;
}

export function FilterBar({ compact }: { compact?: boolean }) {
  const { filters: f, setFilters, ix, resetFilters } = useStore();
  const ps = presets(ix.cur, ix.firstActual);
  const active = ps.find((p) => p.f.from === f.from && p.f.to === f.to && p.f.granularity === f.granularity);
  const g = f.groupId ? ix.groupById[f.groupId] : null;
  const toggle = (on: boolean, label: string, onClick: () => void, title: string) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${on ? C.blue : C.line2}`,
        background: on ? C.bg2 : '#fff',
        color: on ? C.blueDark : C.muted,
        borderRadius: 999,
        padding: '7px 12px',
        font: `600 12.5px ${FONT}`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <i style={{ width: 8, height: 8, borderRadius: 99, background: on ? C.blue : C.line2 }} />
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <select
        aria-label="Időszak"
        value={active ? active.key : 'custom'}
        onChange={(e) => {
          const p = ps.find((x) => x.key === e.target.value);
          if (p) setFilters(p.f);
        }}
        style={{ ...inputStyle, height: 36, font: `600 13px ${FONT}`, color: C.navy }}
      >
        {ps.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">Egyéni időszak…</option>
      </select>
      {(!active || !compact) && (
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <input
            aria-label="Ettől"
            type="month"
            value={f.from}
            onChange={(e) => e.target.value && setFilters({ from: e.target.value })}
            style={{ ...inputStyle, height: 36, width: 140 }}
          />
          <span style={{ color: C.muted }}>–</span>
          <input
            aria-label="Eddig"
            type="month"
            value={f.to}
            onChange={(e) => e.target.value && setFilters({ to: e.target.value })}
            style={{ ...inputStyle, height: 36, width: 140 }}
          />
        </span>
      )}
      <Seg
        small
        value={f.mode}
        onChange={(v) => setFilters({ mode: v })}
        options={[
          ['auto', 'Tény + terv'],
          ['actual', 'Tény'],
          ['plan', 'Terv'],
        ]}
      />
      <Seg
        small
        value={f.section}
        onChange={(v) => setFilters({ section: v, groupId: null })}
        options={[
          ['all', 'Mind'],
          ['in', 'Bevétel'],
          ['out', 'Kiadás'],
        ]}
      />
      {toggle(f.estimate, 'Becslés', () => setFilters({ estimate: !f.estimate }), 'A tervek után az elmúlt 12 hónap rendszeres tételeinek átlagával becsül')}
      {toggle(f.includeOffers, 'Ajánlatok', () => setFilters({ includeOffers: !f.includeOffers }), 'A még el nem fogadott ajánlatok beszámítása')}
      <input
        aria-label="Keresés"
        placeholder="Keresés…"
        value={f.search}
        onChange={(e) => setFilters({ search: e.target.value })}
        style={{ ...inputStyle, height: 36, width: compact ? '100%' : 170, flex: compact ? '1 1 100%' : undefined }}
      />
      {g && (
        <button
          onClick={() => setFilters({ groupId: null })}
          style={{ border: 0, background: C.navy, color: '#fff', borderRadius: 999, padding: '7px 12px', font: `600 12.5px ${FONT}`, cursor: 'pointer' }}
        >
          {displayGroup(g.label)} ×
        </button>
      )}
      {!compact && (
        <button onClick={resetFilters} style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 12.5px ${FONT}`, cursor: 'pointer' }}>
          Alaphelyzet
        </button>
      )}
    </div>
  );
}
