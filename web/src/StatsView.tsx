// Statisztika: Terv vs. tény (havonta) · Partnerek · Partnernevek (átnevezés, összevonás).
import { useState } from 'react';
import { PartnerNames, PartnersView } from './PartnersView';
import { PlanActualView } from './PlanActualView';
import { C, FONT, FONT_H, Seg } from './ui';

export type StatsTab = 'pva' | 'partners' | 'names';

export function StatsView({
  mobile,
  initialTab = 'pva',
  partnerKey,
  onPartnerBack,
}: {
  mobile?: boolean;
  initialTab?: StatsTab;
  partnerKey?: string | null;
  onPartnerBack?: () => void;
}) {
  const [tab, setTab] = useState<StatsTab>(partnerKey ? 'partners' : initialTab);
  return (
    <div
      style={{ padding: mobile ? '12px 16px 24px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: mobile ? undefined : 1200 }}
    >
      {!mobile && (
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>Statisztika</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>
            {tab === 'pva' ? 'Terv vs. tény' : tab === 'partners' ? 'Partnerek' : 'Partnernevek'}
          </h1>
        </div>
      )}
      <Seg
        full={mobile}
        value={tab}
        onChange={setTab}
        options={[
          ['pva', 'Terv vs. tény'],
          ['partners', 'Partnerek'],
          ['names', 'Partnernevek'],
        ]}
      />
      {tab === 'pva' && <PlanActualView mobile={mobile} />}
      {tab === 'partners' && <PartnersView key={partnerKey || 'list'} mobile={mobile} initialKey={partnerKey} onBack={onPartnerBack} />}
      {tab === 'names' && <PartnerNames />}
    </div>
  );
}
