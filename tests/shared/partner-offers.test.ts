// Ajánlat-követés: egy ajánlat = egy sorozat, vagy azonos nevű tételek egy partnernél. A tételnevekben a program a hónapot
// („– 2026. november”) és a részlet sorszámát („– 2. részlet”) is a névhez teszi – ettől egy ajánlat nem válhat többé.
import { describe, expect, it } from 'vitest';
import { groupRejected } from '../../src/client/RejectedOffers';
import { offerConversion } from '../../src/shared/insights';
import type { Entry, LostOffer } from '../../src/shared/types';

const plan = (p: Partial<Entry>): Entry => ({
  id: Math.random().toString(36).slice(2),
  kind: 'plan',
  date: '2026-11-10',
  leaf_id: 'l_minta',
  name: '',
  amount: 0,
  series_id: null,
  done: 0,
  tentative: 0,
  was_offer: 1,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  ...p,
});
const lost = (p: Partial<LostOffer>): LostOffer =>
  ({ id: Math.random().toString(36).slice(2), leaf_id: 'l_pelda', date: '2026-11-01', amount: 400_000, series_id: null, deleted_at: 0, offer_at: null, ...p }) as LostOffer;

describe('ajánlatok megvalósulása: a hónappal / részlettel ellátott nevek egy ajánlatnak számítanak', () => {
  it('két részletben elfogadott weboldal-ajánlat 1 megnyert ajánlat; a 3 hónapos elutasított kampány 1 elveszett', () => {
    const won = [
      plan({ name: 'Weboldal készítése – 1. részlet – 2026. november', amount: 490_000, date: '2026-11-10' }),
      plan({ name: 'Weboldal készítése – 2. részlet – 2026. december', amount: 490_000, date: '2026-12-08' }),
    ];
    const rejected = [
      lost({ name: 'Google Ads kampány – 2026. november', date: '2026-11-05' }),
      lost({ name: 'Google Ads kampány – 2026. december', date: '2026-12-05' }),
      lost({ name: 'Google Ads kampány – 2027. január', date: '2027-01-05' }),
    ];
    const s = offerConversion(won, rejected, '2026-11-07');
    expect(s.wonN).toBe(1);
    expect(s.lostN).toBe(1);
    expect(s.rate).toBe(0.5);
    expect(s.wonSum).toBe(980_000);
    expect(s.lostSum).toBe(1_200_000);
  });

  it('különböző nevű ajánlatok külön számítanak', () => {
    const s = offerConversion(
      [plan({ name: 'Webshop – 2026. december', amount: 1_970_000 }), plan({ name: 'Outlet aloldal – 2027. január', amount: 620_000 })],
      [],
      '2026-11-07',
    );
    expect(s.wonN).toBe(2);
  });

  it('a partner adatlapon az elutasított havi ajánlat egy sorként, a hónapok számával látszik', () => {
    const rows = groupRejected([
      lost({ name: 'Social média kezelés – 2026. november', date: '2026-11-01', amount: 150_000, deleted_at: 1_790_000_000_000 }),
      lost({ name: 'Social média kezelés – 2026. december', date: '2026-12-01', amount: 150_000, deleted_at: 1_790_000_000_000 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Social média kezelés', n: 2, sum: 300_000, from: '2026-11-01', to: '2026-12-01' });
  });
});
