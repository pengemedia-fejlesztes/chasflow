// Grafikonok: a vezetői áttekintés, a bevétel, a bank és likviditás, a költség és a feladatok animált grafikonjai –
// ugyanazokból a számításokból, mint a program többi oldala (Áttekintés, Statisztikák, Fedezeti pont, Bankszinkron).
import { useMemo, type ReactNode } from 'react';
import { partnerIdOf } from '../../shared/partners';
import { addMonths, actualBalanceAt, monthLabel, monthLong, monthRange, outlook, fmt } from '../../shared/model';
import { offerConversion, receivablesAging } from '../../shared/insights';
import { breakeven } from '../../shared/worktime';
import { displayGroup } from '../../shared/categories';
import { TASK_TYPES, isOpen, isOverdue } from '../../shared/tasks';
import { BAD, BarChart, Funnel, GOOD, HBars, Legend, LineChart, SERIES } from './charts';
import { useLedger } from './LedgerView';
import { useStore } from './store';
import { TYPE_COLOR } from './TasksView';
import { C, FONT, FONT_H, card } from './ui';

function Card({ title, sub, children, legend, i, wide }: { title: string; sub: string; children: ReactNode; legend?: ReactNode; i: number; wide?: boolean }) {
  return (
    <section
      className="cf-card"
      style={{
        ...card,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
        gridColumn: wide ? '1 / -1' : undefined,
        animationDelay: i * 70 + 'ms',
      }}
    >
      <div>
        <h2 style={{ margin: 0, font: `700 18px ${FONT_H}`, color: C.navy }}>{title}</h2>
        <p style={{ margin: '4px 0 0', font: `400 12.5px/1.5 ${FONT}`, color: C.muted }}>{sub}</p>
      </div>
      {legend}
      {children}
    </section>
  );
}

const Empty = ({ t }: { t: string }) => <div style={{ padding: '30px 0', textAlign: 'center', color: C.muted, font: `500 13.5px ${FONT}` }}>{t}</div>;

export function ChartsView() {
  const { ix, data, openPartner } = useStore();
  const cur = ix.cur;
  const sumLeafs = (m: Map<string, Map<string, number>>, ym: string, pred: (leaf: string) => boolean) => {
    let s = 0;
    for (const [leaf, mm] of m) if (pred(leaf)) s += mm.get(ym) || 0;
    return s;
  };
  const isIn = (l: string) => ix.sectionOf(l) === 'in';
  const isOut = (l: string) => ix.sectionOf(l) === 'out';

  // 1. egyenleg-előrejelzés
  const bal = useMemo(() => {
    const past = monthRange(addMonths(cur, -6), addMonths(cur, -1));
    const plan = outlook(ix, { includeOffers: false, estimate: true }).months;
    const offer = outlook(ix, { includeOffers: true, estimate: true }).months;
    const labels = [...past, ...plan.map((m) => m.ym)].map((ym) => monthLabel(ym) + (ym.slice(5) === '01' ? ' ' + ym.slice(2, 4) : ''));
    const n = past.length;
    return {
      labels,
      marker: n,
      series: [
        {
          label: 'Tény (záró egyenleg)',
          color: SERIES[0],
          values: [...past.map((ym) => Math.round(actualBalanceAt(ix, ym))), Math.round(plan[0]?.bal || 0), ...plan.slice(1).map(() => null)],
          area: true,
        },
        { label: 'Terv', color: C.navy, values: [...past.map(() => null), ...plan.map((m) => Math.round(m.bal))] },
        { label: 'Ajánlatokkal együtt', color: SERIES[1], values: [...past.map(() => null), ...offer.map((m) => Math.round(m.bal))], dashed: true },
      ],
      low: plan.reduce((a, m) => (m.bal < a.bal ? m : a), plan[0]),
    };
  }, [ix, cur]);

  // 2. havi bevétel – kiadás + nettó
  const flow = useMemo(() => {
    const yms = monthRange(addMonths(cur, -6), addMonths(cur, 5));
    const v = yms.map((ym) => {
      const past = ym < cur;
      const src = (pred: (l: string) => boolean) =>
        past ? sumLeafs(ix.actual, ym, pred) : ym === cur ? sumLeafs(ix.actual, ym, pred) + sumLeafs(ix.openPlan, ym, pred) : sumLeafs(ix.openPlan, ym, pred);
      return { inc: Math.round(src(isIn)), exp: Math.round(src(isOut)) };
    });
    return { yms, inc: v.map((x) => x.inc), exp: v.map((x) => x.exp), net: v.map((x) => x.inc + x.exp) };
  }, [ix, cur]);

  // 3. terv vs. tény eltérés partnerenként (előző lezárt hónap)
  const dev = useMemo(() => {
    const ym = addMonths(cur, -1);
    const rows: { label: string; value: number; leaf: string }[] = [];
    for (const l of ix.leaves) {
      const a = ix.actual.get(l.id)?.get(ym) || 0;
      const p = ix.plan.get(l.id)?.get(ym) || 0;
      if (!a && !p) continue;
      const d = Math.round(a - p);
      if (Math.abs(d) >= 1000) rows.push({ label: l.label, value: d, leaf: l.id });
    }
    return { ym, rows: rows.sort((x, y) => Math.abs(y.value) - Math.abs(x.value)).slice(0, 12) };
  }, [ix, cur]);

  // 4. ügyfélkoncentráció (12 hó bevétel)
  const conc = useMemo(() => {
    const yms = monthRange(addMonths(cur, -12), addMonths(cur, -1));
    const by = new Map<string, { label: string; v: number; leaf: string }>();
    for (const l of ix.leaves) {
      if (!isIn(l.id)) continue;
      const v = yms.reduce((s, ym) => s + (ix.actual.get(l.id)?.get(ym) || 0), 0);
      if (v <= 0) continue;
      const k = partnerIdOf(l.label);
      const x = by.get(k) || { label: l.label, v: 0, leaf: l.id };
      x.v += v;
      by.set(k, x);
    }
    const list = [...by.values()].sort((a, b) => b.v - a.v);
    const total = list.reduce((s, x) => s + x.v, 0);
    const top = list.slice(0, 9);
    const rest = list.slice(9).reduce((s, x) => s + x.v, 0);
    return { total, rows: [...top, ...(rest ? [{ label: `Egyéb (${list.length - 9} partner)`, v: rest, leaf: '' }] : [])] };
  }, [ix, cur]);

  // 5. ajánlat-tölcsér (12 hó)
  const funnel = useMemo(() => {
    const since = addMonths(cur, -11) + '-01';
    const oc = offerConversion(data.entries, data.lostOffers || [], data.today);
    const key = (e: { leaf_id: string; series_id?: string | null; name?: string | null }) => e.leaf_id + '|' + (e.series_id || e.name || '');
    const recent = <T extends { date: string }>(xs: T[]) => xs.filter((e) => e.date >= since);
    const won = recent(oc.won);
    const lost = recent(oc.lost as any[]);
    const open = recent(data.entries.filter((e) => e.kind === 'plan' && e.tentative && !e.done));
    const sum = (xs: { amount: number }[]) => xs.reduce((s, e) => s + Math.abs(e.amount), 0);
    const nOf = (xs: any[]) => new Set(xs.map(key)).size;
    const billed = won.filter((e) => e.done || data.billingo.some((d) => d.plan_id === e.id) || (data.navInvoices || []).some((n) => n.plan_id === e.id));
    const paid = won.filter((e) => e.done);
    return [
      { label: 'Kiadott ajánlat', n: nOf([...won, ...lost, ...open]), sum: sum([...won, ...lost, ...open]) },
      { label: 'Elfogadott', n: nOf(won), sum: sum(won) },
      { label: 'Kiszámlázott', n: nOf(billed), sum: sum(billed) },
      { label: 'Kifizetett', n: nOf(paid), sum: sum(paid) },
    ];
  }, [data.entries, data.lostOffers, data.billingo, data.navInvoices, data.today, cur]);

  // 6. kintlévőségek kora
  const aging = useMemo(() => receivablesAging(data.entries, ix.sectionOf, data.today, data.billingo), [data.entries, data.billingo, data.today, ix]);

  // 7–8. bankszámlák (csak banki adat)
  const { r: ledger } = useLedger(cur, '');
  const bank = useMemo(() => {
    if (!ledger) return null;
    const months = ledger.months.slice(-12);
    const labels = months.map((m) => monthLabel(m.ym));
    const series = ledger.accounts.map((a, i) => ({
      label: a.bank_name,
      color: SERIES[i % SERIES.length],
      values: months.map((m) => m.accounts[a.id]?.close?.amount ?? null),
    }));
    const diff = months
      .map((m) => {
        const full = ledger.accounts.every((a) => m.accounts[a.id]?.open && m.accounts[a.id]?.close);
        if (!full) return null;
        const change = ledger.accounts.reduce((s, a) => s + m.accounts[a.id].close!.amount - m.accounts[a.id].open!.amount, 0);
        const cf = sumLeafs(ix.actual, m.ym, () => true);
        return { ym: m.ym, v: Math.round(change - cf) };
      })
      .filter((x): x is { ym: string; v: number } => !!x);
    return { labels, series, diff };
  }, [ledger, ix]);

  // 9. költségszerkezet havonta csoportonként
  const cost = useMemo(() => {
    const yms = monthRange(addMonths(cur, -11), cur);
    const groups = ix.groups.filter((g) => g.section === 'out');
    const series = groups
      .map((g) => ({ label: displayGroup(g.label), values: yms.map((ym) => Math.round(-sumLeafs(ix.actual, ym, (l) => ix.leafById[l]?.group_id === g.id))) }))
      .filter((s) => s.values.some((v) => v > 0))
      .sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0))
      .slice(0, 7)
      .map((s, i) => ({ ...s, color: SERIES[i] }));
    return { yms, series };
  }, [ix, cur]);

  // 10. fedezeti pont
  const be = useMemo(() => {
    const months = monthRange(addMonths(cur, -12), addMonths(cur, -1));
    const aliases = new Map<string, string[]>();
    for (const l of ix.leaves) {
      const p = (data.partners || []).find((x) => x.key === partnerIdOf(l.label));
      if (p) aliases.set(l.id, [p.name, ...(p.aliases || [])]);
    }
    const rep = breakeven({
      months,
      entries: data.entries,
      leaves: ix.leaves,
      groups: ix.groups,
      employees: data.employees || [],
      worktime: data.worktime || [],
      aliases,
    });
    return {
      labels: months.map(monthLabel),
      revenue: rep.map((m) => Math.round(m.revenue)),
      be: rep.map((m) => (m.breakeven === null ? null : Math.round(m.breakeven))),
      util: rep.map((m) => (m.minutes ? Math.round((m.billableMinutes / m.minutes) * 100) : null)),
    };
  }, [ix, data.entries, data.employees, data.worktime, data.partners, cur]);

  // 11. feladatterhelés a héten felelősönként, típus szerint
  const load = useMemo(() => {
    const until = new Date(Date.parse(data.today) + 7 * 86400000).toISOString().slice(0, 10);
    const open = (data.tasks || []).filter((t) => isOpen(t.status) && t.due_date <= until);
    const users = (data.taskUsers || []).filter((u) => open.some((t) => t.assignee_id === u.id));
    return {
      labels: users.map((u) => {
        const late = open.filter((t) => t.assignee_id === u.id && isOverdue(t, data.today)).length;
        return u.name.split(' ').slice(-1)[0] + (late ? ` (${late} lejárt)` : '');
      }),
      series: TASK_TYPES.map(([k, l]) => ({
        label: l,
        color: TYPE_COLOR[k],
        values: users.map((u) => open.filter((t) => t.assignee_id === u.id && t.type === k).length),
      })).filter((s) => s.values.some(Boolean)),
      total: open.length,
    };
  }, [data.tasks, data.taskUsers, data.today]);

  let n = 0;
  return (
    <div style={{ padding: '24px 28px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, font: `800 32px/1.05 ${FONT_H}`, color: C.navy }}>Grafikonok</h1>
        <p style={{ margin: '8px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted }}>
          Vigye az egeret a grafikonra a pontos értékekért. A számok ugyanazokból az adatokból jönnek, mint az Áttekintés, a Fedezeti pont és a Bankszinkron.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 560px), 1fr))', gap: 16 }}>
        <Card
          i={n++}
          wide
          title="Egyenleg-előrejelzés"
          sub={`Havi záró egyenleg: tény az elmúlt 6 hónapra, terv a következő 12 hónapra, és ajánlatokkal együtt. Mélypont (terv): ${bal.low ? monthLong(bal.low.ym) + ' · ' + fmt(bal.low.bal) + ' Ft' : '–'}.`}
          legend={<Legend items={bal.series.map((s) => ({ label: s.label, color: s.color, dashed: s.dashed }))} />}
        >
          <LineChart labels={bal.labels} series={bal.series} marker={bal.marker} height={260} zero={false} />
        </Card>

        <Card
          i={n++}
          wide
          title="Havi bevétel, kiadás és eredmény"
          sub="Elmúlt 6 hónap tény (a folyó hónapban tény + nyitott terv), következő 6 hónap terv (halványabb). A vonal a havi nettó eredmény."
          legend={
            <Legend
              items={[
                { label: 'Bevétel', color: GOOD },
                { label: 'Kiadás', color: BAD },
                { label: 'Nettó eredmény', color: C.navy },
              ]}
            />
          }
        >
          <BarChart
            labels={flow.yms.map(monthLabel)}
            series={[
              { label: 'Bevétel', color: GOOD, values: flow.inc },
              { label: 'Kiadás', color: BAD, values: flow.exp },
            ]}
            line={{ label: 'Nettó eredmény', color: C.navy, values: flow.net }}
            hatch={(i) => flow.yms[i] > cur}
          />
        </Card>

        <Card
          i={n++}
          title="Terv vs. tény eltérés"
          sub={`${monthLong(dev.ym)} · partnerenként a tény és a terv különbsége (eredményhatás): zöld = jobb a tervnél, piros = rosszabb. Kattintásra a partner adatlapja.`}
        >
          {dev.rows.length ? (
            <HBars
              rows={dev.rows.map((r) => ({ label: r.label, value: r.value, color: r.value >= 0 ? GOOD : BAD }))}
              onClick={(i) => openPartner(dev.rows[i].leaf)}
            />
          ) : (
            <Empty t="Ebben a hónapban nincs 1000 Ft-nál nagyobb eltérés." />
          )}
        </Card>

        <Card
          i={n++}
          title="Ügyfélkoncentráció"
          sub={`Az elmúlt 12 hónap bevétele partnerenként (összesen ${fmt(conc.total)} Ft). A szaggatott vonal a 30%-os küszöb: e fölött egy ügyfél elvesztése komoly kockázat.`}
        >
          {conc.rows.length ? (
            <HBars
              rows={conc.rows.map((r, i) => ({
                label: r.label,
                value: r.v,
                color: r.v / (conc.total || 1) > 0.3 ? BAD : SERIES[i === 9 ? 0 : 0],
                note: Math.round((r.v / (conc.total || 1)) * 100) + '%',
              }))}
              threshold={{ value: conc.total * 0.3, label: '30% küszöb' }}
              onClick={(i) => conc.rows[i].leaf && openPartner(conc.rows[i].leaf)}
            />
          ) : (
            <Empty t="Nincs bevétel az elmúlt 12 hónapban." />
          )}
        </Card>

        <Card i={n++} title="Ajánlat-tölcsér" sub="Az elmúlt 12 hónap ajánlatai: kiadott → elfogadott → kiszámlázott → kifizetett, összeggel és darabszámmal.">
          <Funnel steps={funnel} />
        </Card>

        <Card
          i={n++}
          title="Kintlévőségek kora"
          sub={`Ki nem fizetett bevételek a lejárat óta eltelt napok szerint. Lejárt összesen: ${fmt(aging.overdue)} Ft.`}
        >
          <HBars
            rows={aging.buckets.map((b, i) => ({
              label: b.label,
              value: Math.round(b.sum),
              color: ['#2a78d6', '#fab219', '#ec835a', '#d03b3b', '#9b2a2a'][i],
              note: b.items.length + ' tétel',
            }))}
          />
        </Card>

        <Card
          i={n++}
          title="Bankszámlák egyenlege"
          sub="Havi záró egyenleg számlánként – csak banki adatból (a bank által jelentett vagy a kivonat szerinti). Ahol nincs banki adat, a vonal megszakad."
          legend={bank ? <Legend items={bank.series.map((s) => ({ label: s.label, color: s.color }))} /> : null}
        >
          {!bank ? (
            <Empty t="Betöltés…" />
          ) : bank.series.some((s) => s.values.some((v) => v !== null)) ? (
            <LineChart labels={bank.labels} series={bank.series} zero={false} />
          ) : (
            <Empty t="Még nincs mentett banki egyenleg." />
          )}
        </Card>

        <Card
          i={n++}
          title="Banki változás vs. cashflow"
          sub="Havonta a banki egyenleg változása mínusz a rögzített tények: ha nem nulla, abban a hónapban hiányzó vagy jóváhagyásra váró tétel van. Csak a teljes banki adattal rendelkező hónapok."
        >
          {bank && bank.diff.length ? (
            <HBars rows={bank.diff.map((d) => ({ label: monthLong(d.ym), value: d.v, color: Math.abs(d.v) < 1000 ? GOOD : BAD }))} />
          ) : (
            <Empty
              t={
                bank
                  ? 'Még nincs olyan hónap, amelynek nyitó és záró egyenlege is banki adatból megvan (rögzíts kivonat szerinti egyenleget a Számlatörténetben).'
                  : 'Betöltés…'
              }
            />
          )}
        </Card>

        <Card
          i={n++}
          wide
          title="Költségszerkezet havonta"
          sub="Tényleges kiadások csoportonként, az elmúlt 12 hónapban (a folyó hónap eddig)."
          legend={<Legend items={cost.series.map((s) => ({ label: s.label, color: s.color }))} />}
        >
          <BarChart labels={cost.yms.map(monthLabel)} series={cost.series} stacked />
        </Card>

        <Card
          i={n++}
          title="Fedezeti pont"
          sub="Havi bevétel (tény) a fedezeti ponthoz képest: ha a bevétel a szaggatott vonal fölött van, a hónap nyereséges. A munkaidő-táblák alapján számolva."
          legend={
            <Legend
              items={[
                { label: 'Bevétel', color: GOOD },
                { label: 'Fedezeti pont', color: BAD, dashed: true },
              ]}
            />
          }
        >
          {be.be.some((v) => v !== null) ? (
            <LineChart
              labels={be.labels}
              series={[
                { label: 'Bevétel', color: GOOD, values: be.revenue, area: true },
                { label: 'Fedezeti pont', color: BAD, values: be.be, dashed: true },
              ]}
            />
          ) : (
            <Empty t="Nincs munkaidő-adat a fedezeti ponthoz (Fedezeti pont › munkaidő-táblák)." />
          )}
        </Card>

        <Card
          i={n++}
          title="Feladatterhelés a héten"
          sub={`Nyitott feladatok a következő 7 napban és a lejártak, felelősönként, típus szerint (${load.total} feladat).`}
          legend={<Legend items={load.series.map((s) => ({ label: s.label, color: s.color }))} />}
        >
          {load.labels.length ? (
            <BarChart labels={load.labels} series={load.series} stacked height={220} integer />
          ) : (
            <Empty t="Nincs nyitott feladat a következő 7 napban." />
          )}
        </Card>
      </div>
    </div>
  );
}
