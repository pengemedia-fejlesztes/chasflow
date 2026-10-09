// Kategória (csoport) nézet: tervezett sorozatok havi rácsban + a szűrt időszak tényei.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, endOfMonth, fmt, monthLabel, monthRange, ymOf } from '../../shared/model';
import type { Entry, Rep } from '../../shared/types';
import type { EditTarget } from './EntryModal';
import { REP, ruleOf, dateIn, deleteEntries, extendRows, genSeries, markDone, rowKey, shiftEntries, uid } from './logic';
import { useStore } from './store';
import { C, FONT, FONT_H, LeafSelect, Seg, card, eyebrow, inputStyle } from './ui';

export function CategoryView({ groupId, openModal }: { groupId: string; openModal: (leaf: string | null, edit?: EditTarget) => void }) {
  const { ix, data, filters, commit, canEdit } = useStore();
  const G = ix.groupById[groupId];
  const leafIds = useMemo(() => new Set(ix.leaves.filter((l) => l.group_id === groupId).map((l) => l.id)), [ix, groupId]);
  const section = G?.section || 'out';
  const sign = section === 'in' ? 1 : -1;
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const firstLeaf = ix.leaves.find((l) => l.group_id === groupId && !l.archived)?.id || '';
  const [qa, setQa] = useState({ name: '', amount: '', leaf: firstLeaf, m: ix.cur, rep: 'monthly' as Rep, count: 6 });
  const [showAll, setShowAll] = useState(false);
  if (!G) return null;
  const qaLeaf = leafIds.has(qa.leaf) ? qa.leaf : firstLeaf;

  const allMonths = monthRange(filters.from, filters.to);
  const months = allMonths.filter((m) => m >= ix.cur).slice(0, 12);
  const visibleSet = new Set(months);
  const groupEntries = data.entries.filter((e) => leafIds.has(e.leaf_id));
  const planEntries = groupEntries.filter((e) => e.kind === 'plan');
  const rowsMap = new Map<string, Entry[]>();
  for (const e of planEntries) {
    const k = rowKey(e);
    if (!rowsMap.has(k)) rowsMap.set(k, []);
    rowsMap.get(k)!.push(e);
  }
  const rows = [...rowsMap.entries()]
    .filter(([, es]) => es.some((e) => visibleSet.has(ymOf(e.date))))
    .filter(([, es]) => !filters.search || es.some((e) => (e.name + ' ' + ix.leafById[e.leaf_id]?.label).toLowerCase().includes(filters.search.toLowerCase())))
    .sort(
      (a, b) =>
        (ix.leafById[a[1][0].leaf_id]?.label || '').localeCompare(ix.leafById[b[1][0].leaf_id]?.label || '', 'hu') ||
        a[1][0].name.localeCompare(b[1][0].name, 'hu'),
    );

  const rangeEnd = endOfMonth(filters.to) < data.today ? endOfMonth(filters.to) : data.today;
  const actuals = groupEntries
    .filter((e) => e.kind === 'actual' && e.date >= filters.from + '-01' && e.date <= rangeEnd)
    .filter((e) => !filters.search || (e.name + ' ' + ix.leafById[e.leaf_id]?.label).toLowerCase().includes(filters.search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date));
  const actSum = actuals.reduce((s, e) => s + e.amount * sign, 0);
  const planSum = planEntries.filter((e) => visibleSet.has(ymOf(e.date)) && !e.tentative).reduce((s, e) => s + e.amount * sign, 0);
  const openSum = planEntries.filter((e) => visibleSet.has(ymOf(e.date)) && !e.done && !e.tentative).reduce((s, e) => s + e.amount * sign, 0);

  const selIds = Object.keys(sel).filter((k) => sel[k]);
  const selSum = data.entries.filter((e) => sel[e.id]).reduce((s, e) => s + e.amount * sign, 0);
  const clear = () => setSel({});

  const qaSave = () => {
    const amt = parseInt(String(qa.amount).replace(/\D/g, '')) || 0;
    if (!amt || !qaLeaf) return;
    const name = qa.name.trim() || ix.leafById[qaLeaf].label;
    const b = genSeries({ leaf: qaLeaf, section, name, amount: amt, startYm: qa.m, count: qa.count, rep: qa.rep, day: 10, payRule: ruleOf(ix, qaLeaf) });
    commit(b, `${b.upsert!.length} tétel felvéve: ${name}`);
    setQa({ ...qa, name: '', amount: '' });
  };

  const gridCols = `44px minmax(220px,1.5fr) 118px repeat(${months.length},minmax(112px,1fr)) 48px`;
  const minW = 450 + months.length * 116;

  return (
    <div style={{ padding: '28px 32px 140px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>
            {section === 'in' ? 'Bevétel' : 'Kiadás'} · kategória
          </div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy, letterSpacing: '-.01em' }}>{displayGroup(G.label)}</h1>
        </div>
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {[
            ['Terv (látható hónapok)', planSum, C.navy],
            ['Ebből nyitott', openSum, C.navy],
            ['Tény (időszak)', actSum, C.blue],
          ].map(([l, v, c]) => (
            <div key={l as string} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={eyebrow}>{l}</span>
              <span style={{ font: `800 22px ${FONT_H}`, color: c as string, fontVariantNumeric: 'tabular-nums' }}>{fmt(v as number)}</span>
            </div>
          ))}
        </div>
      </div>

      {canEdit && (
        <div
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && qaSave()}
          style={{ ...card, padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}
        >
          <span style={{ font: `700 13px ${FONT_H}`, color: C.navy, marginRight: 4 }}>Gyors felvitel</span>
          <input
            value={qa.name}
            onChange={(e) => setQa({ ...qa, name: e.target.value })}
            placeholder="Megnevezés"
            style={{ ...inputStyle, flex: '1 1 180px', minWidth: 150 }}
          />
          <input
            value={qa.amount}
            inputMode="numeric"
            onChange={(e) => setQa({ ...qa, amount: e.target.value.replace(/[^\d ]/g, '') })}
            placeholder="Összeg (Ft)"
            style={{ ...inputStyle, width: 130, textAlign: 'right', fontWeight: 600 }}
          />
          <select value={qaLeaf} onChange={(e) => setQa({ ...qa, leaf: e.target.value })} style={inputStyle}>
            {ix.leaves
              .filter((l) => l.group_id === groupId && !l.archived)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
          </select>
          <select value={qa.m} onChange={(e) => setQa({ ...qa, m: e.target.value })} style={inputStyle}>
            {monthRange(ix.cur, addMonths(ix.cur, 17)).map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)} {m.slice(0, 4)}
              </option>
            ))}
          </select>
          <Seg
            small
            value={qa.rep}
            onChange={(v) => setQa({ ...qa, rep: v })}
            options={[
              ['once', 'Egyszeri'],
              ['monthly', 'Havonta'],
              ['quarterly', 'Negyedév'],
            ]}
          />
          {qa.rep !== 'once' && (
            <select value={qa.count} onChange={(e) => setQa({ ...qa, count: Number(e.target.value) })} style={inputStyle}>
              <option value={3}>3 hónapig</option>
              <option value={6}>6 hónapig</option>
              <option value={12}>12 hónapig</option>
              <option value={24}>24 hónapig</option>
            </select>
          )}
          <button
            className="hov-dark"
            onClick={qaSave}
            style={{
              height: 38,
              border: 0,
              borderRadius: 999,
              background: C.navy,
              color: '#fff',
              padding: '0 18px',
              font: `600 13.5px ${FONT}`,
              cursor: 'pointer',
            }}
          >
            Hozzáad ↵
          </button>
        </div>
      )}

      {months.length > 0 ? (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', font: `400 12.5px ${FONT}`, color: C.muted, alignItems: 'center' }}>
            <Legend bg={C.bg2} border={`1px solid ${C.line2}`} text="tervezett — ○ pipálás: kész · összegre kattintás: kijelölés" />
            <Legend bg={C.blue} text="kijelölt" />
            <Legend bg="#fff" border={`1px solid ${C.blue}`} text="✓ kész (kézzel vagy bankból)" />
            <Legend bg="transparent" border={`1px dashed ${C.line2}`} text="üres — kattintás: tétel ide másolása" />
          </div>
          <div style={{ ...card, overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, minWidth: minW, background: C.navy, color: '#fff', alignItems: 'center' }}>
              <div />
              <div style={{ padding: '12px 8px', font: `700 13px ${FONT_H}` }}>Tétel</div>
              <div style={{ padding: '12px 8px', font: `700 13px ${FONT_H}` }}>Ismétlődés</div>
              {months.map((m) => (
                <div key={m} style={{ padding: '10px 8px', textAlign: 'center', display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ font: `700 12.5px ${FONT_H}` }}>{monthLabel(m)}</span>
                  <span style={{ font: `500 10.5px ${FONT}`, color: C.muted2 }}>{m.slice(0, 4)}</span>
                </div>
              ))}
              <div />
            </div>
            {rows.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Ebben az időszakban nincs tervezett tétel.</div>
            )}
            {rows.map(([key, es]) => {
              const s = data.series.find((x) => x.id === es[0].series_id);
              const openEs = es.filter((e) => !e.done && visibleSet.has(ymOf(e.date)));
              const allSel = openEs.length > 0 && openEs.every((e) => sel[e.id]);
              const anySel = openEs.some((e) => sel[e.id]);
              const typical = (openEs[0] || es[es.length - 1]).amount;
              const inferred: Rep = s?.rep || (es.length > 1 ? 'monthly' : 'once');
              const tentative = es.some((e) => e.tentative);
              const fromBillingo = es.some((e) => e.source === 'billingo');
              const day = s?.day || Number(es[0].date.slice(8));
              return (
                <div
                  key={key}
                  className="row-hover"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: gridCols,
                    minWidth: minW,
                    alignItems: 'center',
                    borderTop: `1px solid ${C.line}`,
                    background: anySel ? '#F7FAFD' : '#fff',
                  }}
                >
                  <div style={{ paddingLeft: 16, display: 'flex' }}>
                    {canEdit && (
                      <input
                        type="checkbox"
                        checked={allSel}
                        onChange={() =>
                          setSel((x) => {
                            const n = { ...x };
                            openEs.forEach((e) => (allSel ? delete n[e.id] : (n[e.id] = true)));
                            return n;
                          })
                        }
                        style={{ width: 16, height: 16, accentColor: C.blue, cursor: 'pointer' }}
                      />
                    )}
                  </div>
                  <div
                    onClick={() => canEdit && openModal(null, { key })}
                    style={{ padding: '10px 8px', display: 'flex', flexDirection: 'column', cursor: canEdit ? 'pointer' : 'default', minWidth: 0 }}
                    title="Szerkesztés"
                  >
                    <span style={{ font: `600 14px ${FONT}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {es[0].name || ix.leafById[es[0].leaf_id]?.label}
                    </span>
                    <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                      {ix.leafById[es[0].leaf_id]?.label} · fizetés:{' '}
                      {inferred === 'once' ? `${monthLabel(ymOf(es[0].date))} ${day}.` : `${inferred === 'quarterly' ? 'negyedévente' : 'minden hó'} ${day}.`}
                    </span>
                  </div>
                  <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        font: `600 11.5px ${FONT}`,
                        padding: '4px 10px',
                        borderRadius: 999,
                        background: inferred === 'once' ? C.bg : C.bg2,
                        color: inferred === 'once' ? C.muted : C.blueDark,
                      }}
                    >
                      {REP[inferred]}
                    </span>
                    {tentative && <span style={{ font: `600 10.5px ${FONT}`, color: '#8A6D1C' }}>ajánlat</span>}
                    {fromBillingo && <span style={{ font: `600 10.5px ${FONT}`, color: C.blueDark }}>Billingo számla</span>}
                  </div>
                  {months.map((m) => {
                    const list = es.filter((e) => ymOf(e.date) === m);
                    if (!list.length)
                      return (
                        <div key={m} style={{ padding: '6px 4px' }}>
                          <button
                            disabled={!canEdit}
                            title={`Kattints: ${fmt(Math.abs(typical))} Ft ide másolása`}
                            onClick={() => {
                              const src = es[es.length - 1];
                              commit(
                                {
                                  upsert: [
                                    {
                                      ...src,
                                      id: uid('e'),
                                      date: dateIn(m, Number(src.date.slice(8))),
                                      done: 0,
                                      link_id: null,
                                      ext_ref: null,
                                      source: 'manual',
                                      amount: typical,
                                    },
                                  ],
                                },
                                `${src.name || 'Tétel'} bemásolva: ${monthLabel(m)}`,
                              );
                            }}
                            className="cell-empty"
                            style={{
                              width: '100%',
                              height: 30,
                              borderRadius: 8,
                              border: `1px dashed ${C.line}`,
                              background: 'transparent',
                              cursor: canEdit ? 'pointer' : 'default',
                            }}
                          />
                        </div>
                      );
                    const amt = list.reduce((a, e) => a + e.amount * sign, 0);
                    const done = list.every((e) => e.done);
                    const isSel = list.some((e) => sel[e.id]);
                    const d = list[0].date.slice(8).replace(/^0/, '') + '.';
                    const overdue = !done && list[0].date < data.today;
                    return (
                      <div key={m} style={{ padding: '6px 4px' }}>
                        <div
                          style={{
                            width: '100%',
                            height: 30,
                            borderRadius: 8,
                            border: `1px solid ${done ? C.blue : isSel ? C.blue : overdue ? C.neg : C.line2}`,
                            background: done ? '#fff' : isSel ? C.blue : C.bg2,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 2,
                            paddingLeft: 4,
                          }}
                        >
                          {canEdit && (
                            <button
                              title={done ? 'Kész – kattintás: visszaállítás nyitottra' : 'Kipipálás: kész'}
                              onClick={() =>
                                commit(
                                  markDone(
                                    data,
                                    list.map((e) => e.id),
                                    !done,
                                  ),
                                  `${list.length} tétel ${!done ? 'késznek jelölve ✓' : 'visszaállítva nyitottra'}`,
                                )
                              }
                              style={{
                                width: 18,
                                height: 18,
                                flex: 'none',
                                borderRadius: 999,
                                border: `1.5px solid ${done ? C.blue : isSel ? '#fff' : C.muted2}`,
                                background: done ? C.blue : '#fff',
                                color: done ? '#fff' : C.blue,
                                font: `700 10px/1 ${FONT}`,
                                padding: 0,
                                cursor: 'pointer',
                                display: 'grid',
                                placeItems: 'center',
                              }}
                            >
                              {done ? '✓' : ''}
                            </button>
                          )}
                          <button
                            onClick={() =>
                              !done &&
                              canEdit &&
                              setSel((x) => {
                                const n = { ...x };
                                list.filter((e) => !e.done).forEach((e) => (isSel ? delete n[e.id] : (n[e.id] = true)));
                                return n;
                              })
                            }
                            title={done ? 'Teljesült' : overdue ? 'Lejárt, még nyitott' : 'Kattints a kijelöléshez'}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              height: '100%',
                              border: 0,
                              background: 'transparent',
                              color: done ? C.blueDark : isSel ? '#fff' : C.navy,
                              font: `600 12.5px ${FONT}`,
                              fontVariantNumeric: 'tabular-nums',
                              cursor: 'pointer',
                              padding: '0 6px 0 2px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 4,
                            }}
                          >
                            <span style={{ font: `500 10.5px ${FONT}`, opacity: 0.7 }}>{d}</span>
                            <span>{fmt(amt)}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    {canEdit && (
                      <button
                        onClick={() => openModal(null, { key })}
                        title="Szerkesztés"
                        className="icon-btn"
                        style={{
                          width: 30,
                          height: 30,
                          border: 0,
                          borderRadius: 8,
                          background: 'transparent',
                          color: C.muted,
                          cursor: 'pointer',
                          font: `600 15px ${FONT}`,
                        }}
                      >
                        ✎
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: gridCols,
                minWidth: minW,
                alignItems: 'center',
                borderTop: `2px solid ${C.line2}`,
                background: C.bg,
              }}
            >
              <div />
              <div style={{ padding: '12px 8px', font: `700 13px ${FONT_H}`, color: C.navy }}>Összesen</div>
              <div />
              {months.map((m) => (
                <div
                  key={m}
                  style={{ padding: '12px 8px', textAlign: 'center', font: `700 12.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmt(planEntries.filter((e) => ymOf(e.date) === m && !e.tentative).reduce((a, e) => a + e.amount * sign, 0))}
                </div>
              ))}
              <div />
            </div>
          </div>
        </>
      ) : (
        <div style={{ ...card, padding: 18, font: `500 13.5px ${FONT}`, color: C.muted }}>
          A kiválasztott időszak a múltban van – lent a tényleges tételeket látod. Tervekhez válassz jövőbeli időszakot.
        </div>
      )}

      <div style={{ ...card, overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            borderBottom: `1px solid ${C.line}`,
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>Tények a szűrt időszakban</span>
          <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
            {actuals.length} tétel · {fmt(actSum)} Ft
          </span>
        </div>
        {actuals.length === 0 && <div style={{ padding: 20, color: C.muted, font: `500 13.5px ${FONT}` }}>Nincs tényleges tétel ebben az időszakban.</div>}
        {(showAll ? actuals : actuals.slice(0, 60)).map((e) => (
          <div
            key={e.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '90px minmax(0,1fr) minmax(160px,240px) 120px 40px',
              gap: 10,
              alignItems: 'center',
              padding: '9px 18px',
              borderTop: `1px solid ${C.line3}`,
            }}
          >
            <span style={{ font: `600 12.5px ${FONT}`, color: C.muted }}>{e.date.replace(/-/g, '.')}.</span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ font: `600 13.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.name || '—'}
              </span>
              <span style={{ font: `400 11.5px ${FONT}`, color: C.muted }}>
                {{ import: 'xls import', bank: 'bankból', manual: 'kézi', billingo: 'Billingo' }[e.source] || e.source}
              </span>
            </span>
            {canEdit ? (
              <LeafSelect
                ix={ix}
                section={section}
                value={e.leaf_id}
                onChange={(v) => commit({ upsert: [{ ...e, leaf_id: v }] }, `Átsorolva: ${ix.leafById[v].label}`)}
                style={{ height: 32, fontSize: 12.5 }}
              />
            ) : (
              <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>{ix.leafById[e.leaf_id]?.label}</span>
            )}
            <span style={{ textAlign: 'right', font: `700 13.5px ${FONT}`, color: e.amount * sign < 0 ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(e.amount * sign)}
            </span>
            {canEdit ? (
              <button
                title="Törlés"
                onClick={() => confirm('Törlöd ezt a tényleges tételt?') && commit({ delete: [e.id] }, 'Tétel törölve')}
                className="icon-btn"
                style={{ border: 0, background: 'transparent', color: C.muted, cursor: 'pointer', font: `600 14px ${FONT}` }}
              >
                ×
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
        {!showAll && actuals.length > 60 && (
          <button
            onClick={() => setShowAll(true)}
            style={{
              width: '100%',
              border: 0,
              borderTop: `1px solid ${C.line}`,
              background: C.bg3,
              padding: 12,
              color: C.blueDark,
              font: `600 13px ${FONT}`,
              cursor: 'pointer',
            }}
          >
            Mind a {actuals.length} tétel mutatása
          </button>
        )}
      </div>

      {selIds.length > 0 && (
        <div style={{ position: 'sticky', bottom: 20, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div
            style={{
              pointerEvents: 'auto',
              background: C.navy,
              color: '#fff',
              borderRadius: 999,
              padding: '8px 8px 8px 20px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 2px 4px rgba(0,32,64,.06),0 24px 48px rgba(0,32,64,.22)',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ font: `600 13.5px ${FONT}`, marginRight: 6 }}>
              {selIds.length} tétel · {fmt(selSum)} Ft
            </span>
            <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,.15)' }} />
            <span style={{ ...eyebrow, color: C.muted2, margin: '0 4px 0 6px' }}>Áthelyezés</span>
            {[-1, 1, 2, 3].map((n) => (
              <button
                key={n}
                onClick={() => (commit(shiftEntries(data, selIds, n), `${selIds.length} tétel áthelyezve ${n > 0 ? '+' : ''}${n} hónappal`), clear())}
                style={selBtn(n < 0 ? C.navy3 : C.blue)}
              >
                {n > 0 ? '+' : '−'}
                {Math.abs(n)} hó
              </button>
            ))}
            <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,.15)' }} />
            <button onClick={() => (commit(extendRows(data, selIds), 'Sorozat meghosszabbítva 3 hónappal'), clear())} style={selBtn(C.navy3)}>
              Sorozat +3 hó
            </button>
            <button
              onClick={() => (commit(markDone(data, selIds, true), `${selIds.length} tétel késznek jelölve ✓`), clear())}
              style={{ ...selBtn('#fff'), color: C.navy }}
            >
              ✓ Kész
            </button>
            <button
              onClick={() => (commit(deleteEntries(data, selIds), `${selIds.length} tétel törölve`), clear())}
              style={{ ...selBtn('transparent'), color: C.negLight }}
            >
              Törlés
            </button>
            <button onClick={clear} style={{ ...selBtn('transparent'), color: C.muted2, width: 34, padding: 0 }}>
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const selBtn = (bg: string): React.CSSProperties => ({
  border: 0,
  borderRadius: 999,
  background: bg,
  color: '#fff',
  padding: '9px 13px',
  font: `600 13px ${FONT}`,
  cursor: 'pointer',
  height: 34,
});

function Legend({ bg, border, text }: { bg: string; border?: string; text: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <i style={{ width: 12, height: 12, borderRadius: 4, background: bg, border }} />
      {text}
    </span>
  );
}
