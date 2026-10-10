// Statisztikák központ: csoportosított lista (Beállítások → Statisztikák), egy kattintással a részletes nézet.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import {
  concentration,
  costStructure,
  liquidity,
  offerConversion,
  receivablesAging,
  revenueTrend,
  seasonality,
  targetTracking,
  taxForecast,
} from '../../shared/insights';
import { addMonths, buildEstimates, fmt, fmtM, monthLong, monthRange, MSL } from '../../shared/model';
import { api } from './api';
import { useBack } from './back';
import { DivergingBars } from './Bars';
import { PartnerNames, PartnersView, usePartners } from './PartnersView';
import { PlanActualView } from './PlanActualView';
import { useStore } from './store';
import { C, FONT, FONT_H, card } from './ui';

export type StatId =
  | 'target'
  | 'season'
  | 'offers'
  | 'tax'
  | 'pva'
  | 'trend'
  | 'liquidity'
  | 'aging'
  | 'partners'
  | 'concentration'
  | 'discipline'
  | 'names'
  | 'costs';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const dd = (d: string) => d.replace(/-/g, '.') + '.';

interface Card {
  id: StatId;
  title: string;
  desc: string;
  value?: string;
  red?: boolean;
}

export function StatsHub({
  mobile,
  initial,
  partnerKey,
  onPartnerBack,
}: {
  mobile?: boolean;
  initial?: StatId | null;
  partnerKey?: string | null;
  onPartnerBack?: () => void;
}) {
  const { data, ix, run, isAdmin } = useStore();
  const [tInput, setTInput] = useState(data.settings.profit_target || '');
  const [open, setOpen] = useState<StatId | null>(partnerKey ? 'partners' : initial || null);
  useBack(!!open && !partnerKey, () => setOpen(null));
  const partners = usePartners();
  const liq = useMemo(() => liquidity(ix), [ix]);
  const trend = useMemo(() => revenueTrend(ix, 24), [ix]);
  const costs = useMemo(() => costStructure(ix), [ix]);
  const conc = useMemo(() => concentration(partners.map((p) => ({ name: p.name, v: p.sides.in?.last12 || 0 }))), [partners]);
  const aging = useMemo(() => receivablesAging(data.entries, ix.sectionOf, data.today), [data.entries, ix, data.today]);
  const target = Number(data.settings.profit_target || 0);
  const tMonths = monthRange(addMonths(ix.cur, -12), ix.cur);
  const tt = useMemo(() => targetTracking(ix, target, tMonths), [ix, target, tMonths.join()]);
  const offers = useMemo(() => offerConversion(data.entries, data.lostOffers || [], data.today), [data.entries, data.lostOffers, data.today]);
  const taxMonths = monthRange(addMonths(ix.cur, 1), addMonths(ix.cur, 6));
  const tax = useMemo(() => taxForecast(ix, buildEstimates(ix, addMonths(ix.cur, 7)), taxMonths), [ix, taxMonths.join()]);
  const season = useMemo(() => seasonality(ix), [ix]);
  const weakest = [...season.rows].sort((a, b) => a.index - b.index)[0];
  const nextTax = tax.rows.reduce((s, r) => s + (r.forecast[0]?.est || 0), 0);
  const discipline = partners.filter((p) => p.avgLate !== null).sort((a, b) => (b.avgLate || 0) - (a.avgLate || 0));

  const groupsList: { title: string; cards: Card[] }[] = [
    {
      title: 'Eredmény és terv',
      cards: [
        { id: 'pva', title: 'Terv vs. tény', desc: 'Havi bevétel, kiadás, profit – terv, tény, eltérés' },
        {
          id: 'target',
          title: 'Havi eredmény-cél',
          desc: 'Elérte-e a havi eredmény a célt – riasztással',
          value: target
            ? `${tt.filter((t) => !t.forecast && t.ok).length} / ${tt.filter((t) => !t.forecast).length} hónap teljesült`
            : 'cél még nincs beállítva',
          red: !!target && tt.some((t) => !t.ok),
        },
        {
          id: 'season',
          title: 'Szezonalitás',
          desc: 'Melyik hónap szokott erős vagy gyenge lenni',
          value: weakest ? `leggyengébb: ${MSL[weakest.m - 1]} (${weakest.index}%)` : undefined,
        },
        {
          id: 'trend',
          title: 'Bevétel-trend',
          desc: 'Havi bevétel 24 hónapra, 3 havi mozgóátlaggal',
          value: trend.yoy === null ? undefined : `${trend.yoy > 0 ? '+' : ''}${pct(trend.yoy)} az előző évhez`,
          red: (trend.yoy ?? 0) < 0,
        },
      ],
    },
    {
      title: 'Likviditás',
      cards: [
        {
          id: 'liquidity',
          title: 'Likviditás és runway',
          desc: 'Hány hónapra elég a pénz a mostani ütemmel',
          value: liq.runway === null ? 'nincs mínusz' : `${Math.round(liq.runway)} hónap`,
          red: liq.runway !== null && liq.runway < 12,
        },
        {
          id: 'aging',
          title: 'Kintlévőségek kora',
          desc: 'Lejárt, ki nem fizetett bevételek napok szerint',
          value: `${fmt(aging.overdue)} Ft lejárt`,
          red: aging.overdue > 0,
        },
      ],
    },
    {
      title: 'Partnerek',
      cards: [
        { id: 'partners', title: 'Partner statisztika', desc: 'Partnerenként: bevétel, kiadás, várható tételek, számlák' },
        {
          id: 'concentration',
          title: 'Ügyfélkoncentráció',
          desc: 'Mekkora a legnagyobb ügyfelek aránya a bevételből',
          value: conc.list[0] ? `${conc.list[0].name}: ${pct(conc.top1)}` : undefined,
          red: conc.top1 > 0.4,
        },
        {
          id: 'discipline',
          title: 'Fizetési fegyelem',
          desc: 'Ki fizet késve – átlagos késés napokban',
          value: discipline[0] && (discipline[0].avgLate || 0) > 0 ? `${discipline[0].name}: ${Math.round(discipline[0].avgLate!)} nap` : undefined,
        },
        { id: 'names', title: 'Partnernevek', desc: 'Átnevezés és összevonás (pl. Palakovics + Palakovics Ferenc)' },
      ],
    },
    {
      title: 'Értékesítés',
      cards: [
        {
          id: 'offers',
          title: 'Ajánlatok megvalósulása',
          desc: 'Hány ajánlatból lett bevétel – megnyert, elveszett, nyitott',
          value: offers.rate === null ? `${offers.open.length + offers.expired.length} nyitott ajánlat` : `${pct(offers.rate)} megvalósult`,
          red: offers.expired.length > 0,
        },
      ],
    },
    {
      title: 'Költségek',
      cards: [
        {
          id: 'costs',
          title: 'Költségszerkezet',
          desc: 'Mire megy el a pénz – csoportok és tételek, változás az előző évhez',
          value: `${fmtM(costs.total)} / 12 hó`,
        },
        {
          id: 'tax',
          title: 'ÁFA és adók előrejelzése',
          desc: 'Várható adók a következő 6 hónapra a bevétel alapján',
          value: `${monthLong(addMonths(ix.cur, 1)).replace(/^\d+\. /, '')}: ~${fmt(nextTax)} Ft`,
        },
      ],
    },
  ];

  if (open) {
    const card_ = groupsList.flatMap((g) => g.cards).find((c) => c.id === open)!;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!partnerKey && (
          <button
            onClick={() => setOpen(null)}
            style={{
              alignSelf: 'flex-start',
              border: 0,
              background: 'transparent',
              color: C.blueDark,
              font: `600 14px ${FONT}`,
              padding: 0,
              cursor: 'pointer',
            }}
          >
            ‹ Statisztikák
          </button>
        )}
        <h2 style={{ margin: 0, font: `700 ${mobile ? 21 : 26}px/1.15 ${FONT_H}`, color: C.navy }}>{card_.title}</h2>
        {open === 'pva' && <PlanActualView mobile={mobile} />}
        {open === 'partners' && <PartnersView key={partnerKey || 'list'} mobile={mobile} initialKey={partnerKey} onBack={onPartnerBack} />}
        {open === 'names' && <PartnerNames />}
        {open === 'trend' && (
          <>
            <Kpis
              items={[
                ['Utolsó 12 hónap', `${fmt(trend.last12)} Ft`],
                ['Előző 12 hónap', `${fmt(trend.prev12)} Ft`],
                ['Változás', trend.yoy === null ? '–' : `${trend.yoy > 0 ? '+' : ''}${pct(trend.yoy)}`, (trend.yoy ?? 0) < 0],
                ['Havi átlag (3 hó)', `${fmt(trend.rows.at(-1)?.ma3 || 0)} Ft`],
              ]}
            />
            <DivergingBars
              title="Havi bevétel (tény)"
              markerLabel="3 havi átlag"
              points={trend.rows.map((r) => ({ ym: r.ym, v: r.v, plan: Math.round(r.ma3) }))}
            />
            <Note>A vonal a 3 havi mozgóátlag: ha tartósan a vonal alatt vannak az oszlopok, csökken a bevétel.</Note>
          </>
        )}
        {open === 'liquidity' && (
          <>
            <Kpis
              items={[
                ['Mai egyenleg', `${fmt(liq.balance)} Ft`],
                ['Havi nettó (3 havi átlag)', `${liq.net3 > 0 ? '+' : ''}${fmt(liq.net3)} Ft`, liq.net3 < 0],
                ['Runway', liq.runway === null ? 'nincs mínusz' : `${Math.round(liq.runway)} hónap`, liq.runway !== null && liq.runway < 12],
                [
                  'Költségfedezet',
                  liq.coverMonths === null ? (liq.balance <= 0 ? 'nincs fedezet' : '–') : `${liq.coverMonths.toFixed(1).replace('.', ',')} hónap`,
                ],
              ]}
            />
            <Note>
              <b>Runway</b>: ha a következő hónapok is úgy alakulnak, mint az elmúlt 3 (átlag bevétel {fmt(liq.inc3)} Ft, kiadás {fmt(liq.out3)} Ft), ennyi
              hónapra elég a mai egyenleg. <b>Költségfedezet</b>: ha egyáltalán nem jönne bevétel, ennyi hónap kiadását fedezi a pénz. Az elmúlt 12 hónap havi
              átlagos nettója: {fmt(liq.net12)} Ft.
            </Note>
          </>
        )}
        {open === 'aging' && (
          <>
            {aging.buckets.map((b) => (
              <div key={b.key} style={{ ...card, padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <b style={{ font: `700 14px ${FONT_H}`, color: b.key === 'notdue' ? C.navy : C.neg }}>{b.label}</b>
                  <b style={{ font: `700 14px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(b.sum)} Ft</b>
                </div>
                {b.items.length === 0 && <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>nincs ilyen tétel</span>}
                {b.items.map((e) => (
                  <div key={e.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
                    <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, width: 84, flex: 'none' }}>{dd(e.date)}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        font: `500 13.5px ${FONT}`,
                        color: C.ink,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {e.name || ix.leafById[e.leaf_id]?.label} <span style={{ color: C.muted }}>· {ix.leafById[e.leaf_id]?.label}</span>
                    </span>
                    <b style={{ font: `700 13.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount)}</b>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
        {open === 'concentration' && (
          <>
            <Kpis
              items={[
                ['Legnagyobb ügyfél', pct(conc.top1), conc.top1 > 0.4],
                ['TOP 3', pct(conc.top3)],
                ['TOP 5', pct(conc.top5)],
                ['Fizető ügyfelek (12 hó)', `${conc.count}`],
              ]}
            />
            <div style={{ ...card, padding: '10px 14px' }}>
              {conc.list.slice(0, 15).map((x) => (
                <div key={x.name} style={{ padding: '6px 0', borderTop: `1px solid ${C.line3}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ flex: 1, font: `600 13.5px ${FONT}`, color: C.ink }}>{x.name}</span>
                    <b style={{ font: `700 13px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(x.v)} · {pct(x.share)}
                    </b>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: C.line3 }}>
                    <div style={{ width: pct(x.share), height: '100%', borderRadius: 999, background: x.share > 0.4 ? '#E36B57' : C.blue }} />
                  </div>
                </div>
              ))}
            </div>
            <Note>
              Egészséges, ha a legnagyobb ügyfél legfeljebb 30–40%-ot ad. HHI-index: {conc.hhi} (2500 fölött erősen koncentrált). Az utolsó 12 hónap bevétele
              alapján.
            </Note>
          </>
        )}
        {open === 'discipline' && (
          <div style={{ ...card, padding: '10px 14px' }}>
            {discipline.length === 0 && (
              <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>Még nincs fizetett Billingo-számla az elmúlt 13 hónapból.</span>
            )}
            {discipline.map((p) => (
              <div key={p.key} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <b style={{ font: `600 14px ${FONT}`, color: C.ink }}>{p.name}</b>
                  <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                    {p.invoices.length} számla · {p.lateCount} késve fizetve{p.outstanding ? ` · lejárt: ${fmt(p.outstanding)} Ft` : ''}
                  </span>
                </span>
                <b style={{ font: `700 14px ${FONT}`, color: (p.avgLate || 0) > 3 ? C.neg : '#1A7340' }}>
                  {(p.avgLate || 0) <= 0 ? 'határidőre' : `${Math.round(p.avgLate!)} nap késés`}
                </b>
              </div>
            ))}
          </div>
        )}
        {open === 'target' && (
          <>
            <div style={{ ...card, padding: '12px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 180px', font: `600 13.5px ${FONT}`, color: C.navy }}>Havi eredmény-cél (bevétel − kiadás)</span>
              {isAdmin ? (
                <>
                  <input
                    value={tInput ? fmt(Number(String(tInput).replace(/\D/g, '')) * (String(tInput).trim().startsWith('-') ? -1 : 1)) : ''}
                    onChange={(e) => setTInput(e.target.value.replace(/[^\d-]/g, ''))}
                    inputMode="numeric"
                    placeholder="pl. 500 000"
                    style={{
                      height: 40,
                      width: 150,
                      border: `1.5px solid ${C.line2}`,
                      borderRadius: 10,
                      padding: '0 10px',
                      font: `700 15px ${FONT_H}`,
                      color: C.navy,
                    }}
                  />
                  <button
                    onClick={() =>
                      run(() => api('/api/settings', { method: 'PUT', body: { profit_target: String(parseInt(String(tInput)) || 0) } }), 'Eredmény-cél mentve')
                    }
                    style={{
                      height: 40,
                      border: 0,
                      borderRadius: 999,
                      background: C.navy,
                      color: '#fff',
                      padding: '0 16px',
                      font: `600 14px ${FONT}`,
                      cursor: 'pointer',
                    }}
                  >
                    Mentés
                  </button>
                </>
              ) : (
                <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>{target ? `${fmt(target)} Ft` : 'nincs beállítva'}</b>
              )}
            </div>
            {target ? (
              <>
                <DivergingBars
                  title="Havi eredmény a célhoz képest"
                  markerLabel="cél"
                  points={tt.map((t) => ({ ym: t.ym, v: t.net, plan: target, future: t.forecast, note: t.forecast ? 'várható' : undefined }))}
                />
                <div style={{ ...card, padding: '10px 14px' }}>
                  {[...tt].reverse().map((t) => (
                    <div key={t.ym} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
                      <span style={{ flex: 1, font: `600 13.5px ${FONT}`, color: C.ink }}>
                        {monthLong(t.ym)} {t.forecast ? <span style={{ color: C.muted, fontWeight: 500 }}>(várható)</span> : null}
                      </span>
                      <b style={{ font: `700 13.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(t.net)}</b>
                      <b style={{ font: `700 12.5px ${FONT}`, minWidth: 92, textAlign: 'right', color: t.ok ? '#1A7340' : C.neg }}>
                        {t.ok ? '✓ cél teljesült' : `${fmt(t.gap)}`}
                      </b>
                    </div>
                  ))}
                </div>
                <Note>Ha az előző hónap vagy a folyó hónap várható eredménye a cél alatt van, a Riasztások között is megjelenik.</Note>
              </>
            ) : (
              <Note>Add meg a havi eredmény-célt (pl. 500 000 Ft). Utána a program havonta összeveti, és riaszt, ha elmarad tőle.</Note>
            )}
          </>
        )}
        {open === 'season' && (
          <>
            <DivergingBars
              title={`Átlagos havi bevétel naptári hónaponként (${season.from.slice(0, 4)} óta)`}
              markerLabel="éves átlag"
              labelOf={(ym) => MSL[Number(ym.slice(5)) - 1]}
              points={season.rows.map((r) => ({
                ym: `2000-${String(r.m).padStart(2, '0')}`,
                v: Math.round(r.inc),
                plan: Math.round(season.avgInc),
                note: `${r.index}% · ${r.years} év adata`,
              }))}
            />
            <div style={{ ...card, padding: '10px 14px' }}>
              {season.rows.map((r) => (
                <div key={r.m} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
                  <span style={{ width: 90, font: `600 13.5px ${FONT}`, color: C.ink }}>{MSL[r.m - 1]}</span>
                  <span style={{ flex: 1, font: `500 12.5px ${FONT}`, color: C.muted }}>
                    bevétel {fmt(r.inc)} · kiadás {fmt(r.out)}
                  </span>
                  <b style={{ font: `700 13px ${FONT}`, minWidth: 48, textAlign: 'right', color: r.index < 85 ? C.neg : r.index > 115 ? '#1A7340' : C.navy }}>
                    {r.index}%
                  </b>
                </div>
              ))}
            </div>
            <Note>100% = az éves havi átlag. 85% alatt gyenge, 115% fölött erős hónap. Érdemes a gyenge hónapokra tartalékot tervezni.</Note>
          </>
        )}
        {open === 'offers' && (
          <>
            <Kpis
              items={[
                ['Megvalósulási arány', offers.rate === null ? '–' : pct(offers.rate)],
                ['Megnyert', `${offers.won.length} db · ${fmtM(offers.wonSum)}`],
                ['Elveszett (törölt)', `${offers.lost.length} db · ${fmtM(offers.lostSum)}`],
                ['Nyitott', `${offers.open.length + offers.expired.length} db · ${fmtM(offers.openSum)}`],
              ]}
            />
            {[
              ['30 napnál régebben lejárt – döntsd el: megnyert vagy elveszett?', offers.expired, true],
              ['Nyitott ajánlatok', offers.open, false],
              ['Megnyert ajánlatok', offers.won, false],
            ].map(([title, list, red]) => (
              <div key={title as string} style={{ ...card, padding: '10px 14px' }}>
                <b style={{ font: `700 14px ${FONT_H}`, color: red ? C.neg : C.navy }}>
                  {title as string} ({(list as any[]).length})
                </b>
                {(list as any[]).slice(0, 30).map((e: any) => (
                  <div key={e.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
                    <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, width: 84, flex: 'none' }}>{dd(e.date)}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        font: `500 13.5px ${FONT}`,
                        color: C.ink,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {e.name || ix.leafById[e.leaf_id]?.label} <span style={{ color: C.muted }}>· {ix.leafById[e.leaf_id]?.label}</span>
                    </span>
                    <b style={{ font: `700 13.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(Math.abs(e.amount))}</b>
                  </div>
                ))}
              </div>
            ))}
            <Note>
              <b>Megnyert</b>: ajánlatból biztos terv lett (kivetted belőle az „ajánlat” jelölést) vagy késznek jelölted. <b>Elveszett</b>: a törölt ajánlat. A
              követés mostantól pontos; a korábbi ajánlatoknál csak a még meglévők számítanak.
            </Note>
          </>
        )}
        {open === 'tax' && (
          <>
            {tax.rows.length === 0 && <Note>Nincs adófizetés az elmúlt 12 hónapban (ÁFA, KIVA, Adó, Járulékok kategóriák).</Note>}
            {tax.rows.map((r) => (
              <div key={r.id} style={{ ...card, padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>{r.label}</b>
                  <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                    12 hó: {fmt(r.paid12)} Ft · a bevétel {(r.ratio * 100).toFixed(1).replace('.', ',')}%-a
                  </span>
                </div>
                {r.forecast.map((f) => (
                  <div key={f.ym} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.line3}`, alignItems: 'baseline' }}>
                    <span style={{ flex: 1, font: `500 13px ${FONT}`, color: C.ink }}>{monthLong(f.ym)}</span>
                    <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>terv: {f.plan ? fmt(f.plan) : '–'}</span>
                    <b
                      style={{
                        font: `700 13.5px ${FONT}`,
                        minWidth: 90,
                        textAlign: 'right',
                        color: f.plan && Math.abs(f.plan - f.est) > Math.max(20000, f.est * 0.25) ? C.neg : C.navy,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      ~{fmt(f.est)}
                    </b>
                  </div>
                ))}
              </div>
            ))}
            <Note>
              Becslés: az elmúlt 12 hónapban befizetett adó a bevétel arányában × az előző havi (tény, terv és becsült) bevétel. Piros, ha a terv lényegesen
              eltér a becsléstől – ilyenkor érdemes a tervet ellenőrizni. Pontos ÁFA-hoz a NAV Online Számla bekötése kell.
            </Note>
          </>
        )}
        {open === 'costs' && (
          <>
            <div style={{ ...card, padding: '10px 14px' }}>
              <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>Csoportonként (utolsó 12 hónap)</b>
              {costs.groups.map((g) => (
                <CostRow key={g.id} label={displayGroup(g.label)} v={g.last12} prev={g.prev12} total={costs.total} />
              ))}
            </div>
            <div style={{ ...card, padding: '10px 14px' }}>
              <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>Legnagyobb tételek</b>
              {costs.leaves.slice(0, 15).map((l) => (
                <CostRow key={l.id} label={l.label} sub={displayGroup(l.group)} v={l.last12} prev={l.prev12} total={costs.total} />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Adatok: {monthLong(ix.cur)} · banki egyenleg és tények alapján. Koppints egy statisztikára a részletekért.
      </span>
      {groupsList.map((g) => (
        <div key={g.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted }}>{g.title}</span>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {g.cards.map((c) => (
              <button
                key={c.id}
                onClick={() => setOpen(c.id)}
                style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', cursor: 'pointer' }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <b style={{ font: `700 15px ${FONT}`, color: C.navy }}>{c.title}</b>
                  <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>{c.desc}</span>
                  {c.value && <span style={{ font: `700 13px ${FONT}`, color: c.red ? C.neg : C.blueDark }}>{c.value}</span>}
                </span>
                <span style={{ font: `600 18px ${FONT}`, color: C.blueDark }}>›</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Kpis({ items }: { items: [string, string, boolean?][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
      {items.map(([l, v, red]) => (
        <div key={l} style={{ ...card, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted }}>{l}</span>
          <b style={{ font: `700 17px ${FONT_H}`, color: red ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
        </div>
      ))}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>{children}</span>;
}

function CostRow({ label, sub, v, prev, total }: { label: string; sub?: string; v: number; prev: number; total: number }) {
  const ch = prev ? (v - prev) / prev : null;
  return (
    <div style={{ padding: '7px 0', borderTop: `1px solid ${C.line3}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ flex: 1, minWidth: 0, font: `600 13.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label} {sub && <span style={{ color: C.muted, fontWeight: 500, fontSize: 12 }}>· {sub}</span>}
        </span>
        <b style={{ font: `700 13px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</b>
        <span style={{ font: `600 11.5px ${FONT}`, minWidth: 44, textAlign: 'right', color: ch === null ? C.muted : ch > 0.05 ? C.neg : '#1A7340' }}>
          {ch === null ? 'új' : `${ch > 0 ? '+' : ''}${Math.round(ch * 100)}%`}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: C.line3 }}>
        <div style={{ width: pct(total ? v / total : 0), height: '100%', borderRadius: 999, background: C.muted2 }} />
      </div>
    </div>
  );
}
