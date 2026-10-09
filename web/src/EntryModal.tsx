// Új tétel / sorozat szerkesztése (asztali nézet).
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, fmt, monthLabel, ymOf } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { REP, dateIn, genSeries, rowKey, signed, uid } from './logic';
import { useStore } from './store';
import { C, FONT, FONT_H, Modal, Pill, Seg, eyebrow, inputStyle } from './ui';

export interface EditTarget {
  key: string; // rowKey
}

export function EntryModal({ leaf, edit, onClose }: { leaf?: string | null; edit?: EditTarget | null; onClose: () => void }) {
  const { ix, data, commit } = useStore();
  const rowEntries = useMemo(() => (edit ? data.entries.filter((e) => e.kind === 'plan' && rowKey(e) === edit.key) : []), [edit, data.entries]);
  const series = edit ? data.series.find((s) => s.id === rowEntries[0]?.series_id) : undefined;
  const first = rowEntries.find((e) => !e.done) || rowEntries[0];
  const initLeaf = edit ? first?.leaf_id : leaf || null;
  const [f, setF] = useState(() => ({
    kind: 'plan' as 'plan' | 'actual',
    type: (initLeaf ? ix.sectionOf(initLeaf) : 'in') as Section,
    amount: first ? String(Math.abs(first.amount)) : '',
    name: first?.name || series?.name || '',
    leaf: initLeaf,
    startYm: ix.cur,
    day: String(first ? Number(first.date.slice(8)) : 10),
    rep: (series?.rep || 'once') as Rep,
    count: 6,
    tentative: !!first?.tentative,
    date: data.today,
  }));
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const amt = parseInt(String(f.amount).replace(/\D/g, '')) || 0;
  const months = Array.from({ length: 12 }, (_, i) => addMonths(ix.cur, i));
  const step = f.rep === 'quarterly' ? 3 : 1;
  const n = f.rep === 'once' ? 1 : Math.ceil(Math.min(f.count, 36) / step);
  const L = f.leaf ? ix.leafById[f.leaf] : null;

  const save = () => {
    if (!amt) return alert('Adj meg összeget.');
    if (!f.leaf) return alert('Válassz kategóriát.');
    const name = f.name.trim() || L?.label || '';
    const day = Math.min(31, Math.max(1, parseInt(f.day) || 1));
    if (edit) {
      const open = rowEntries.filter((e) => !e.done);
      const upsert: Entry[] = open.map((e) => ({
        ...e,
        name,
        leaf_id: f.leaf!,
        amount: signed(f.type, amt),
        date: dateIn(ymOf(e.date), day),
        tentative: f.tentative ? 1 : 0,
      }));
      rowEntries.filter((e) => e.done).forEach((e) => upsert.push({ ...e, name, leaf_id: f.leaf! }));
      commit({ upsert, series: series ? [{ ...series, name, leaf_id: f.leaf!, day }] : [] }, `Frissítve: ${name} (${open.length} nyitott tétel)`);
    } else if (f.kind === 'actual') {
      commit(
        {
          upsert: [
            {
              id: uid('a'),
              kind: 'actual',
              date: f.date,
              leaf_id: f.leaf,
              name,
              amount: signed(f.type, amt),
              series_id: null,
              done: 0,
              tentative: 0,
              source: 'manual',
              ext_ref: null,
              link_id: null,
              note: null,
            },
          ],
        },
        `Tény rögzítve: ${name} · ${fmt(amt)} Ft`,
      );
    } else {
      const b = genSeries({ leaf: f.leaf, section: f.type, name, amount: amt, startYm: f.startYm, count: f.count, rep: f.rep, day, tentative: f.tentative });
      commit(b, `${b.upsert!.length} tétel felvéve → ${L?.label}`);
    }
    onClose();
  };

  const del = () => {
    if (!confirm('Törlöd a sorozat összes nyitott tételét?')) return;
    commit({ delete: rowEntries.filter((e) => !e.done).map((e) => e.id) }, 'Sorozat nyitott tételei törölve');
    onClose();
  };

  const groups = ix.groups.filter((g) => g.section === f.type);
  const summary = edit
    ? 'A sorozat minden nyitott tétele frissül. A teljesült (lezárt) tételek összege nem változik.'
    : f.kind === 'actual'
      ? `${amt ? fmt(amt) + ' Ft' : '— Ft'} tény · ${f.date}${L ? ' → ' + L.label : ''}`
      : L
        ? `${amt ? fmt(amt) + ' Ft' : '— Ft'} · ${REP[f.rep].toLowerCase()} · ${monthLabel(f.startYm)}${n > 1 ? '–' + monthLabel(addMonths(f.startYm, (n - 1) * step)) : ''} · ${n} tétel → ${L.label}`
        : 'Válassz kategóriát — Enter menti.';

  return (
    <Modal onClose={onClose}>
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault();
            save();
          }
        }}
      >
        <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>{edit ? 'Tétel szerkesztése' : 'Új tétel'}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!edit && (
              <Seg
                small
                value={f.kind}
                onChange={(v) => set({ kind: v })}
                options={[
                  ['plan', 'Terv'],
                  ['actual', 'Tény'],
                ]}
              />
            )}
            <Seg
              small
              value={f.type}
              onChange={(v) => set({ type: v, leaf: f.leaf && ix.sectionOf(f.leaf) === v ? f.leaf : null })}
              options={[
                ['in', 'Bevétel'],
                ['out', 'Kiadás'],
              ]}
            />
          </div>
        </div>
        <div style={{ padding: '18px 24px 6px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
            <div
              style={{
                flex: '0 0 220px',
                display: 'flex',
                alignItems: 'center',
                border: `1.5px solid ${C.blue}`,
                borderRadius: 14,
                padding: '0 14px',
                background: C.bg2,
              }}
            >
              <input
                autoFocus
                inputMode="numeric"
                value={amt ? fmt(amt) : f.amount}
                onChange={(e) => set({ amount: e.target.value.replace(/\D/g, '') })}
                placeholder="0"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: 0,
                  background: 'transparent',
                  font: `800 26px ${FONT_H}`,
                  color: C.navy,
                  textAlign: 'right',
                  height: 56,
                }}
              />
              <span style={{ font: `600 14px ${FONT}`, color: C.blueDark, marginLeft: 8 }}>Ft</span>
            </div>
            <input
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Megnevezés (pl. Ügyfél – SEO)"
              style={{ ...inputStyle, flex: '1 1 240px', height: 60, borderRadius: 14, padding: '0 16px', fontSize: 15 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={eyebrow}>Kategória</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 210, overflow: 'auto' }}>
              {groups.map((g) => {
                const ls = ix.leaves.filter((l) => l.group_id === g.id && (!l.archived || l.id === f.leaf));
                if (!ls.length) return null;
                return (
                  <div key={g.id} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ font: `600 12px ${FONT}`, color: C.muted, minWidth: 150 }}>{displayGroup(g.label)}</span>
                    {ls.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => set({ leaf: l.id })}
                        style={{
                          border: `1px solid ${f.leaf === l.id ? C.blue : C.line2}`,
                          borderRadius: 999,
                          padding: '6px 12px',
                          font: `600 12.5px ${FONT}`,
                          cursor: 'pointer',
                          background: f.leaf === l.id ? C.blue : '#fff',
                          color: f.leaf === l.id ? '#fff' : C.ink,
                        }}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          {f.kind === 'actual' && !edit ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={eyebrow}>Dátum</span>
              <input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} style={{ ...inputStyle, width: 180 }} />
            </label>
          ) : (
            <>
              {!edit && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={eyebrow}>Kezdő hónap · nap</span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {months.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => set({ startYm: m })}
                        style={{
                          border: `1px solid ${f.startYm === m ? C.navy : C.line2}`,
                          borderRadius: 8,
                          padding: '6px 9px',
                          font: `600 12.5px ${FONT}`,
                          cursor: 'pointer',
                          background: f.startYm === m ? C.navy : '#fff',
                          color: f.startYm === m ? '#fff' : C.ink,
                        }}
                      >
                        {monthLabel(m)}
                      </button>
                    ))}
                    <input
                      aria-label="Nap"
                      inputMode="numeric"
                      value={f.day}
                      onChange={(e) => set({ day: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                      style={{
                        width: 46,
                        height: 31,
                        border: `1px solid ${C.line2}`,
                        borderRadius: 8,
                        textAlign: 'center',
                        font: `600 12.5px ${FONT}`,
                        marginLeft: 4,
                      }}
                    />
                  </div>
                </div>
              )}
              {edit && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={eyebrow}>Fizetési nap</span>
                  <input
                    inputMode="numeric"
                    value={f.day}
                    onChange={(e) => set({ day: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                    style={{ width: 52, height: 34, border: `1px solid ${C.line2}`, borderRadius: 8, textAlign: 'center', font: `600 13px ${FONT}` }}
                  />
                </label>
              )}
              {!edit && (
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <span style={eyebrow}>Ismétlődés</span>
                    <Seg
                      value={f.rep}
                      onChange={(v) => set({ rep: v })}
                      options={[
                        ['once', 'Egyszeri'],
                        ['monthly', 'Havonta'],
                        ['quarterly', 'Negyedévente'],
                      ]}
                    />
                  </div>
                  {f.rep !== 'once' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span style={eyebrow}>Időtartam</span>
                      <Seg
                        value={f.count}
                        onChange={(v) => set({ count: v })}
                        options={[
                          [3, '3 hó'],
                          [6, '6 hó'],
                          [12, '12 hó'],
                          [24, '24 hó'],
                        ]}
                      />
                    </div>
                  )}
                </div>
              )}
              {f.type === 'in' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13.5px ${FONT}`, color: C.ink }}>
                  <input
                    type="checkbox"
                    checked={f.tentative}
                    onChange={(e) => set({ tentative: e.target.checked })}
                    style={{ width: 16, height: 16, accentColor: C.blue }}
                  />
                  Ajánlat (még nem biztos – csak az „Ajánlatok” szűrővel számít bele)
                </label>
              )}
            </>
          )}
        </div>
        <div
          style={{
            marginTop: 14,
            padding: '14px 24px',
            background: C.bg,
            borderTop: `1px solid ${C.line}`,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: 1, minWidth: 200, font: `500 13px/1.4 ${FONT}`, color: C.muted }}>{summary}</span>
          {edit && (
            <Pill kind="danger" onClick={del}>
              Törlés
            </Pill>
          )}
          <Pill onClick={onClose}>Mégse</Pill>
          <Pill kind="primary" onClick={save}>
            Mentés ↵
          </Pill>
        </div>
      </div>
    </Modal>
  );
}
