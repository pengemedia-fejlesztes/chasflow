// Új tétel / sorozat szerkesztése (asztali nézet).
import { useMemo, useState } from 'react';
import { addMonths, fmt, monthLabel, ymOf } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { REP, dateIn, genSeries, rowKey, signed } from './logic';
import { LeafPicker } from './LeafPicker';
import { useStore } from './store';
import { C, DateField, FONT, FONT_H, Modal, Pill, Seg, eyebrow, inputStyle } from './ui';

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
  // új tételnél a kezdő dátum (év–hónap–nap)
  const startDate = f.date;
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const amt = parseInt(String(f.amount).replace(/\D/g, '')) || 0;
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
    } else {
      const b = genSeries({
        leaf: f.leaf,
        section: f.type,
        name,
        amount: amt,
        startYm: ymOf(startDate),
        count: f.count,
        rep: f.rep,
        day: Number(startDate.slice(8)),
        tentative: f.tentative,
      });
      commit(b, `${b.upsert!.length} tétel felvéve → ${L?.label}`);
    }
    onClose();
  };

  const del = () => {
    if (!confirm('Törlöd a sorozat összes nyitott tételét?')) return;
    commit({ delete: rowEntries.filter((e) => !e.done).map((e) => e.id) }, 'Sorozat nyitott tételei törölve');
    onClose();
  };

  const summary = edit
    ? 'A sorozat minden nyitott tétele frissül. A teljesült (lezárt) tételek összege nem változik.'
    : L
      ? `${amt ? fmt(amt) + ' Ft' : '— Ft'} · ${REP[f.rep].toLowerCase()} · ${startDate.replace(/-/g, '. ')}.${n > 1 ? ' – ' + monthLabel(addMonths(ymOf(startDate), (n - 1) * step)) + ' ' + addMonths(ymOf(startDate), (n - 1) * step).slice(0, 4) : ''} · ${n} tétel → ${L.label}`
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
            <span style={eyebrow}>{f.type === 'in' ? 'Ügyfél / kategória' : 'Kategória'}</span>
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              <LeafPicker key={f.type} section={f.type} value={f.leaf} onChange={(id) => set({ leaf: id })} />
            </div>
          </div>
          <>
            {!edit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={eyebrow}>{f.rep === 'once' ? 'Dátum' : 'Első dátum'}</span>
                <DateField value={f.date} min={ix.cur + '-01'} onChange={(v) => set({ date: v })} style={{ width: 260 }} />
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
                  <span style={eyebrow}>Ütemezés</span>
                  <Seg
                    value={f.rep}
                    onChange={(v) => set({ rep: v })}
                    options={[
                      ['once', 'Egyszeri'],
                      ['monthly', 'Havi'],
                      ['quarterly', 'Negyedéves'],
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
