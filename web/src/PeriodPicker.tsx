// Időszakválasztó a natív legördülő helyett: gyors választások csoportosítva + egyéni időszak hónapráccsal.
import { useState } from 'react';
import { MS, type Filters } from '../../shared/model';
import { useBack } from './back';
import { presets } from './Filters';
import { useStore } from './store';
import { C, FONT, FONT_H } from './ui';

export function PeriodPicker({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 38,
          border: `1.5px solid ${C.line2}`,
          borderRadius: 999,
          padding: '0 14px',
          background: '#fff',
          font: `700 13.5px ${FONT}`,
          color: C.navy,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.blueDark} strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        {label}
        <span style={{ color: C.muted, fontSize: 11 }}>▾</span>
      </button>
      {open && <PeriodSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function PeriodSheet({ onClose }: { onClose: () => void }) {
  const { filters: f, setFilters, ix } = useStore();
  useBack(true, onClose);
  const ps = presets(ix.cur, ix.firstActual);
  const active = ps.find((p) => p.f.from === f.from && p.f.to === f.to && p.f.granularity === f.granularity);
  const [custom, setCustom] = useState(!active);
  const [from, setFrom] = useState(f.from);
  const [to, setTo] = useState(f.to);
  const [step, setStep] = useState<'from' | 'to'>('from');
  const [year, setYear] = useState(Number(f.from.slice(0, 4)));
  const mobile = window.innerWidth < 700;
  const pick = (p: Partial<Filters>) => {
    setFilters(p);
    onClose();
  };
  const chip = (key: string, label: string, p: Partial<Filters>, sub?: string) => {
    const on = active?.key === key && !custom;
    return (
      <button
        key={key}
        type="button"
        onClick={() => pick(p)}
        style={{
          border: `1.5px solid ${on ? C.navy : C.line2}`,
          background: on ? C.navy : '#fff',
          color: on ? '#fff' : C.navy,
          borderRadius: 14,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 2,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ font: `700 14px ${FONT}` }}>{label}</span>
        {sub && <span style={{ font: `500 11.5px ${FONT}`, color: on ? C.muted2 : C.muted }}>{sub}</span>}
      </button>
    );
  };
  const byKey = (k: string) => ps.find((p) => p.key === k)!;
  const years = ps.filter((p) => /^y\d{4}$/.test(p.key));
  const head = (t: string) => <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted }}>{t}</span>;
  const ymOf = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  const cmp = (ym: string) => (ym >= from && ym <= to ? (ym === from || ym === to ? 'end' : 'in') : 'out');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,32,64,.45)',
        display: 'flex',
        alignItems: mobile ? 'flex-end' : 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: mobile ? '100%' : 440,
          maxHeight: '92dvh',
          overflow: 'auto',
          background: '#fff',
          borderRadius: mobile ? '24px 24px 0 0' : 18,
          padding: mobile ? '10px 18px calc(env(safe-area-inset-bottom) + 18px)' : 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: '0 20px 50px rgba(0,32,64,.25)',
        }}
      >
        {mobile && <i style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 999, background: C.line2, flex: 'none' }} />}
        <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Időszak</b>
        {head('Előre')}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {chip('n8', 'Következő 8 hónap', byKey('n8').f)}
          {chip('n12', 'Következő 12 hónap', byKey('n12').f)}
          {(() => {
            const ny = ps.find((p) => p.key === 'ny')!;
            return chip('ny', ny.label.replace(' (becslés)', ''), ny.f, 'becslés');
          })()}
        </div>
        {head('Visszatekintés')}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {chip('p12', 'Elmúlt 12 hónap', byKey('p12').f)}
          {(() => {
            const yrs = ps.find((p) => p.key === 'years')!;
            return chip('years', 'Évek összevetése', yrs.f, yrs.label.replace('Évek ', ''));
          })()}
        </div>
        {head('Naptári év')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>{years.map((p) => chip(p.key, p.label.replace('. év', ''), p.f))}</div>
        <button
          type="button"
          onClick={() => setCustom(!custom)}
          style={{
            border: `1.5px solid ${custom ? C.blue : C.line2}`,
            background: custom ? C.bg2 : '#fff',
            color: C.blueDark,
            borderRadius: 14,
            padding: '12px 14px',
            font: `700 14px ${FONT}`,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {custom ? '▾' : '▸'} Egyéni időszak
        </button>
        {custom && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(['from', 'to'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => (setStep(k), setYear(Number((k === 'from' ? from : to).slice(0, 4))))}
                  style={{
                    border: `1.5px solid ${step === k ? C.blue : C.line2}`,
                    background: '#fff',
                    borderRadius: 12,
                    padding: '8px 12px',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'block', font: `600 11px ${FONT}`, color: C.muted }}>{k === 'from' ? 'ETTŐL' : 'EDDIG'}</span>
                  <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>
                    {(k === 'from' ? from : to).slice(0, 4)}. {MS[Number((k === 'from' ? from : to).slice(5)) - 1]}
                  </b>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => setYear(year - 1)} style={navBtn}>
                ‹
              </button>
              <b style={{ flex: 1, textAlign: 'center', font: `700 16px ${FONT_H}`, color: C.navy }}>{year}</b>
              <button type="button" onClick={() => setYear(year + 1)} style={navBtn}>
                ›
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {MS.map((ml, i) => {
                const ym = ymOf(year, i + 1);
                const st = cmp(ym);
                return (
                  <button
                    key={ym}
                    type="button"
                    onClick={() => {
                      if (step === 'from') {
                        setFrom(ym);
                        if (ym > to) setTo(ym);
                        setStep('to');
                      } else {
                        if (ym < from) {
                          setFrom(ym);
                        } else setTo(ym);
                      }
                    }}
                    style={{
                      height: 40,
                      borderRadius: 10,
                      border: 0,
                      background: st === 'end' ? C.navy : st === 'in' ? C.bg2 : C.bg,
                      color: st === 'end' ? '#fff' : C.navy,
                      font: `600 13.5px ${FONT}`,
                      cursor: 'pointer',
                    }}
                  >
                    {ml}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => pick({ from, to, granularity: 'month' })}
              style={{ height: 48, border: 0, borderRadius: 999, background: C.navy, color: '#fff', font: `600 15px ${FONT}`, cursor: 'pointer' }}
            >
              Alkalmaz
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          style={{
            height: 46,
            flex: 'none',
            borderRadius: 999,
            border: `1.5px solid ${C.line2}`,
            background: '#fff',
            color: C.navy,
            font: `600 14.5px ${FONT}`,
            cursor: 'pointer',
          }}
        >
          Mégse
        </button>
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 12,
  border: `1.5px solid ${C.line2}`,
  background: '#fff',
  color: C.navy,
  font: `700 18px ${FONT}`,
  cursor: 'pointer',
};
