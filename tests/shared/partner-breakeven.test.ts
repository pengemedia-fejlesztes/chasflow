// Fedezeti pont – projektenkénti fedezet: a projekt (ügyfél) bevételéből a rá jutó változó költség vonódik le:
// a munkaidő-táblás munkatársak munkaköltsége ÉS az alvállalkozói díj, ha a díj tétele az ügyfelet megnevezi.
// Különben a projekt a valóságosnál jövedelmezőbbnek látszik (a teljes bevétel „fedezet”).
import { describe, expect, it } from 'vitest';
import { breakeven } from '../../src/shared/worktime';
import type { Entry, Group, Leaf } from '../../src/shared/types';

const groups: Group[] = [
  { id: 'gp', section: 'in', label: 'Projektek', sort: 1 },
  { id: 'gm', section: 'out', label: '1 Munkatársak jövedelmei', sort: 2 },
  { id: 'ga', section: 'out', label: '2 Alvállalkozók', sort: 3 },
  { id: 'gk', section: 'out', label: '3 Működési költségek', sort: 4 },
];
const leaves: Leaf[] = [
  { id: 'minta', group_id: 'gp', label: 'Minta Bútor', sort: 1, archived: 0 },
  { id: 'pelda', group_id: 'gp', label: 'Példa Pékség', sort: 2, archived: 0 },
  { id: 'kertes', group_id: 'gp', label: 'Kertész Kft', sort: 3, archived: 0 },
  { id: 'anna', group_id: 'ga', label: 'Szabó Anna', sort: 1, archived: 0 }, // munkaidő-táblás munkatárs (alvállalkozóként fizetve)
  { id: 'bence', group_id: 'ga', label: 'Kovács Bence', sort: 2, archived: 0 }, // alvállalkozó, munkaidő-tábla nélkül
  { id: 'gabor', group_id: 'ga', label: 'Tóth Gábor', sort: 3, archived: 0 }, // alvállalkozó
  { id: 'iroda', group_id: 'gk', label: 'Iroda bérlés', sort: 1, archived: 0 },
];
let n = 0;
const act = (leaf_id: string, amount: number, name: string, date = '2026-09-15'): Entry => ({
  id: 'e' + ++n,
  kind: 'actual',
  date,
  leaf_id,
  name,
  amount,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'bank',
  ext_ref: null,
  link_id: null,
  note: null,
});
const employees = [{ key: 'szaboanna', name: 'Szabó Anna', cost_leaf_id: 'anna' }];
const worktime = [
  { employee: 'szaboanna', ym: '2026-09', project: 'Minta Bútor', tag: 'SEO', minutes: 40 * 60 },
  { employee: 'szaboanna', ym: '2026-09', project: '360 Marketing', tag: 'PM', minutes: 40 * 60 },
];

const run = (entries: Entry[]) =>
  breakeven({ months: ['2026-09'], entries, leaves, groups, employees, worktime, aliases: new Map([['pelda', ['Példa Pékség Kft.', 'PeldaPek']]]) })[0];

describe('fedezeti pont: alvállalkozói díj a projekthez', () => {
  it('a tétel nevében megnevezett ügyfél projektjéből levonódik az alvállalkozói díj', () => {
    const m = run([
      act('minta', 1_524_000, 'Webshop fejlesztés'),
      act('pelda', 381_000, 'Havi díj'),
      act('anna', -320_000, 'Megbízási díj'),
      act('bence', -450_000, 'Minta Bútor - webshop fejlesztés'),
      act('gabor', -90_000, 'PeldaPek hirdetéskezelés'), // alternatív néven
      act('gabor', -60_000, 'Megbízási díj'), // nem nevez meg ügyfelet
      act('iroda', -200_000, 'Bérleti díj'),
    ]);
    const minta = m.projects.find((p) => p.leaf === 'minta')!;
    expect(minta).toMatchObject({ revenue: 1_524_000, laborCost: 160_000, subcontract: 450_000 });
    const pelda = m.projects.find((p) => p.leaf === 'pelda')!;
    expect(pelda).toMatchObject({ revenue: 381_000, laborCost: 0, subcontract: 90_000 });
    // ami egyik ügyfélhez sem köthető, külön látszik (a havi fedezetben benne van, a projektekében nem)
    expect(m.subcontract).toBe(600_000);
    expect(m.subcontractUnassigned).toBe(60_000);
    // a projektek fedezete + a nem köthető alvállalkozói díj + a belső projektek munkaköltsége = a havi fedezet
    const projContrib = m.projects.filter((p) => p.leaf).reduce((s, p) => s + p.revenue - p.laborCost - p.subcontract, 0);
    expect(projContrib - m.subcontractUnassigned).toBe(m.contribution);
  });

  it('belső projekt (360 …) nevű alvállalkozói díj nem kerül ügyfélhez', () => {
    const m = run([act('minta', 500_000, 'Havi díj'), act('gabor', -205_000, '360 új weboldal')]);
    expect(m.projects.find((p) => p.leaf === 'minta')!.subcontract).toBe(0);
    expect(m.subcontractUnassigned).toBe(205_000);
  });

  it('ügyfél, akinek a hónapban nincs bevétele, de alvállalkozói díja van: negatív fedezettel jelenik meg', () => {
    const m = run([act('gabor', -120_000, 'Kertész Kft. kertépítő oldal grafika')]);
    const k = m.projects.find((p) => p.leaf === 'kertes')!;
    expect(k).toMatchObject({ revenue: 0, subcontract: 120_000, minutes: 0 });
  });

  it('banki tény a kedvezményezett nevén: a hozzá kötött terv neve nevezi meg a projektet', () => {
    const paid = act('bence', -100_000, 'KOVÁCS BENCE EV');
    const plan: Entry = {
      ...act('bence', -100_000, 'Példa Pékség – marketing feladatok – 2026. szeptember', '2026-09-30'),
      kind: 'plan',
      done: 1,
      link_id: paid.id,
    };
    const m = run([act('pelda', 381_000, 'Havi díj'), paid, plan]);
    expect(m.projects.find((p) => p.leaf === 'pelda')!.subcontract).toBe(100_000);
    expect(m.subcontractUnassigned).toBe(0);
  });

  it('a munkaidő-táblás munkatárs díja munkaköltségként oszlik meg, nem alvállalkozói díjként', () => {
    const m = run([act('minta', 1_000_000, 'Havi díj'), act('anna', -300_000, 'Minta Bútor megbízási díj')]);
    const minta = m.projects.find((p) => p.leaf === 'minta')!;
    expect(minta.subcontract).toBe(0);
    expect(minta.laborCost).toBe(150_000); // 80 órából 40 a projekten
    expect(m.subcontract).toBe(0);
  });

  it.todo(
    'KÉRDÉS: a munkaidő-táblás munkatárs díja a kifizetés hónapjába (most) vagy a ledolgozott hónapba (előző hónap) tartozik? ' +
      'Ha a díjat a következő hónap elején fizetik, a hónap munkaköltsége 0 lehet (a projektek ultra jövedelmezőnek látszanak), a másik hónapé dupla.',
  );
  it.todo('KÉRDÉS: a munkatárs egy projektet megnevező külön díja (pl. „360 weboldal”) közvetlenül a projektet terhelje, ne a ledolgozott idő arányában?');
  it.todo('KÉRDÉS: a munkaidő-tábla nélküli munkatársak (pl. a tulajdonos bére) költsége a projektekre jusson-e (most fix költség)?');
});
