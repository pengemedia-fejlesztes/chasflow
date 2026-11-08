// Partner adatlap (gépen és mobilon ugyanaz): fejléc avatarral, a cég sávja, fülek: Részletek · Idővonal · Értékesítések,
// alul lebegő gombsor (új tétel / feladat, hívás, e-mail). A Részleteken a névjegyadatok (e-mail, telefon – egy koppintással
// hívható / írható), kapcsolattartók, felelősök, cím, számlázási adatok és egyéni mezők; minden sor helyben szerkeszthető.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { displayGroup } from '../../shared/categories';
import { emptyProfile, type PartnerContact, type PartnerProfile } from '../../shared/catalog';
import { fmt, monthLong, ymOf } from '../../shared/model';
import type { PartnerStat } from '../../shared/partners';
import { TASK_TYPES } from '../../shared/tasks';
import { api } from './api';
import { MobilePartnerScreen } from './MobileFlows';
import { kindOf, PartnerEditor, PaymentTerms, PlannedTasks, SecHead } from './PartnerCard';
import { PartnerBillingTab } from './PartnerBilling';
import { PartnerSheet } from './PartnerSheet';
import { PartnerTasks, TaskEditor } from './TasksView';
import { useStore } from './store';
import { C, FONT, FONT_H, inputStyle, R } from './ui';

type Tab = 'det' | 'time' | 'sales';
const KIND_TAG: Record<string, [string, string, string]> = {
  vevo: ['ÜGYFÉL', '#D3F0E3', '#0B6B45'],
  szallito: ['SZÁLLÍTÓ', '#FBE7CF', '#8A4B05'],
  mindketto: ['ÜGYFÉL ÉS SZÁLLÍTÓ', '#DDE8F7', '#1F4F8F'],
};

const Svg = ({ d, size = 20, sw = 1.9 }: { d: string; size?: number; sw?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const IC = {
  back: 'M15 5l-7 7 7 7',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6',
  pen: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2',
  sms: 'M4 5h16v11H9l-5 4z',
  tag: 'M3 12V4h8l9 9-8 8-9-9zM7.5 7.5h.01',
  building: 'M4 21V4h10v17M14 9h6v12M7 8h2M7 12h2M7 16h2M17 13h1M17 17h1',
  plus: 'M12 5v14M5 12h14',
  chev: 'M9 6l6 6-6 6',
  map: 'M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5',
  web: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18',
};

const initials = (n: string) =>
  n
    .replace(/\b(kft|bt|zrt|nyrt|kkt|ev)\.?\b/gi, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';
const telHref = (p: string) => 'tel:' + p.replace(/[^\d+]/g, '');

export function PartnerView({
  p,
  mobile,
  onClose,
  onNewItem,
  onEditItem,
  onRenamed,
}: {
  p: PartnerStat;
  mobile?: boolean;
  onClose: () => void;
  onNewItem: (leaf: string) => void;
  onEditItem: (leaf: string, key?: string) => void;
  onRenamed: (key: string) => void;
}) {
  const { data, ix, canEdit, run, showToast } = useStore();
  const [tab, setTab] = useState<Tab>('det');
  const [edit, setEdit] = useState<EditReq | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [plusMenu, setPlusMenu] = useState(false);
  const [rename, setRename] = useState(false);
  const prof: PartnerProfile = { ...emptyProfile(), ...(data.partnerProfiles?.[p.key] || {}) };
  const kind = kindOf(p, ix.sectionOf);
  const tag = KIND_TAG[kind] || KIND_TAG.vevo;
  const group = p.groups[0] ? displayGroup(p.groups[0].label) : '';
  const company = prof.company || p.info?.aliases?.find((a) => a !== p.name) || p.billingNames.find((b) => b.name !== p.name)?.name || '';
  const leaf = p.leaves[0]?.id;
  const phone = prof.phone || prof.contacts.find((c) => c.phone)?.phone || '';
  const email = prof.email || prof.billing_email || prof.contacts.find((c) => c.email)?.email || '';
  const users = data.taskUsers || [];

  const saveProfile = (next: Partial<PartnerProfile>, msg: string) =>
    run(() => api(`/api/partner-profile/${encodeURIComponent(p.key)}`, { method: 'PUT', body: { ...prof, ...next } }), `${p.name}: ${msg}`);

  const share = async () => {
    const url = `${location.origin}${location.pathname}#/partners?p=${encodeURIComponent(p.key)}`;
    const text = [p.name, company, email, phone].filter(Boolean).join('\n');
    try {
      if (navigator.share) await navigator.share({ title: p.name, text, url });
      else {
        await navigator.clipboard.writeText(text + '\n' + url);
        showToast('Partner adatai a vágólapra másolva');
      }
    } catch {
      /* megszakítva */
    }
  };

  const pad = mobile ? 16 : 28;
  const wrap: CSSProperties = mobile
    ? { position: 'fixed', inset: 0, zIndex: 950, background: '#fff', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }
    : { background: '#fff', borderRadius: R.lg, minHeight: 640 };

  return (
    <div style={wrap}>
      {/* fejléc */}
      <div style={{ padding: `${mobile ? 'calc(env(safe-area-inset-top) + 10px)' : '18px'} ${pad}px 0`, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RoundBtn label="Vissza" onClick={onClose}>
            <Svg d={IC.back} size={22} sw={2.2} />
          </RoundBtn>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', borderRadius: 999, background: C.bg, padding: 2 }}>
            <RoundBtn label="Megosztás" flat onClick={share}>
              <Svg d={IC.share} />
            </RoundBtn>
            {canEdit && (
              <RoundBtn label="Név átírása" flat onClick={() => setRename(true)}>
                <Svg d={IC.pen} />
              </RoundBtn>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            aria-hidden="true"
            style={{
              width: mobile ? 52 : 60,
              height: mobile ? 52 : 60,
              flex: 'none',
              borderRadius: 999,
              background: `linear-gradient(140deg, ${C.blue}, ${C.navy})`,
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              font: `700 ${mobile ? 18 : 21}px ${FONT_H}`,
            }}
          >
            {initials(p.name)}
          </span>
          {rename ? (
            <RenameInput p={p} onDone={(k) => (setRename(false), k && onRenamed(k))} />
          ) : (
            <h2 style={{ margin: 0, flex: 1, minWidth: 0, font: `700 ${mobile ? 25 : 30}px/1.15 ${FONT_H}`, color: C.navy, overflowWrap: 'anywhere' }}>
              {p.name}
            </h2>
          )}
        </div>
        {(company || p.info?.tax_number) && (
          <button
            type="button"
            onClick={() => setTab('det')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: 0,
              borderRadius: 14,
              background: C.bg,
              padding: '13px 16px',
              textAlign: 'left',
              cursor: 'pointer',
              color: C.blueDark,
            }}
          >
            <Svg d={IC.building} />
            <span style={{ flex: 1, minWidth: 0, font: `600 17px ${FONT}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {company || p.name}
            </span>
            {p.info?.tax_number && <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>{p.info.tax_number}</span>}
          </button>
        )}
        <div role="tablist" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, background: C.bg, borderRadius: 999, padding: 3 }}>
          {(
            [
              ['det', 'Részletek'],
              ['time', 'Idővonal'],
              ['sales', 'Értékesítések'],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              style={{
                height: 38,
                border: 0,
                borderRadius: 999,
                cursor: 'pointer',
                background: tab === k ? '#fff' : 'transparent',
                boxShadow: tab === k ? '0 1px 4px rgba(20,35,58,.14)' : 'none',
                color: tab === k ? C.navy : C.muted,
                font: `${tab === k ? 700 : 500} 14.5px ${FONT}`,
                transition: 'background .15s ease',
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: `14px ${mobile ? 0 : pad}px 120px` }}>
        {tab === 'det' && (
          <Details
            p={p}
            prof={prof}
            tag={tag}
            group={group}
            users={users}
            mobile={mobile}
            canEdit={canEdit}
            onEdit={setEdit}
            onSave={saveProfile}
            onEditItem={onEditItem}
            onRenamed={onRenamed}
          />
        )}
        {tab === 'time' && (
          <div style={{ padding: mobile ? '0 16px' : 0, display: 'flex', flexDirection: 'column', gap: 22 }}>
            <PartnerTasks partnerKey={p.key} />
            <Timeline p={p} />
          </div>
        )}
        {tab === 'sales' &&
          (mobile ? (
            <MobileSales p={p} onNewItem={onNewItem} onEditItem={onEditItem} />
          ) : (
            <PartnerSheet p={p} embedded onClose={onClose} onNewItem={onNewItem} onEditItem={onEditItem} onRenamed={onRenamed} />
          ))}
      </div>

      {/* lebegő gombsor: új (tétel / feladat), hívás, e-mail – szerkesztő ablak alatt rejtve */}
      {!edit && !newTask && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: mobile ? 'calc(env(safe-area-inset-bottom) + 18px)' : 28,
            transform: 'translateX(-50%)',
            width: 'max-content',
            zIndex: 999,
          }}
        >
          {plusMenu && (
            <div
              style={{
                position: 'absolute',
                bottom: 64,
                left: 0,
                background: '#fff',
                borderRadius: 14,
                boxShadow: '0 12px 32px rgba(20,35,58,.22)',
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 190,
              }}
            >
              {leaf && canEdit && <MenuItem onClick={() => (setPlusMenu(false), onNewItem(leaf))}>Új tétel (bevétel / kiadás)</MenuItem>}
              {canEdit && <MenuItem onClick={() => (setPlusMenu(false), setNewTask(true))}>Új feladat</MenuItem>}
              {canEdit && <MenuItem onClick={() => (setPlusMenu(false), setTab('det'), setEdit({ kind: 'contact', index: -1 }))}>Új kapcsolattartó</MenuItem>}
            </div>
          )}
          <div
            className="cf-rise"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              background: C.blue,
              borderRadius: 999,
              padding: 4,
              boxShadow: '0 10px 26px rgba(40,127,170,.38)',
            }}
          >
            {canEdit && (
              <FabBtn label="Új" onClick={() => setPlusMenu((x) => !x)}>
                <Svg d={IC.plus} size={24} sw={2.2} />
              </FabBtn>
            )}
            <FabBtn label={phone ? `Hívás: ${phone}` : 'Nincs telefonszám'} href={phone ? telHref(phone) : undefined}>
              <Svg d={IC.phone} size={22} />
            </FabBtn>
            <FabBtn label={email ? `E-mail: ${email}` : 'Nincs e-mail cím'} href={email ? 'mailto:' + email : undefined}>
              <Svg d={IC.mail} size={22} />
            </FabBtn>
          </div>
        </div>
      )}

      {edit && <EditDialog req={edit} p={p} prof={prof} users={users} onClose={() => setEdit(null)} onSave={saveProfile} />}
      {newTask && <TaskEditor task={null} defaults={{ partner_key: p.key, due_date: data.today }} onClose={() => setNewTask(false)} />}
    </div>
  );
}

// ───────────────────────── Részletek ─────────────────────────

type EditReq =
  | { kind: 'field'; field: 'email' | 'billing_email' | 'phone' | 'contact' | 'website' | 'eu_tax' | 'bank_account' | 'company'; label: string }
  | { kind: 'address' }
  | { kind: 'pay_days' }
  | { kind: 'contact'; index: number }
  | { kind: 'custom'; index: number }
  | { kind: 'followers' };

function Details({
  p,
  prof,
  tag,
  group,
  users,
  mobile,
  canEdit,
  onEdit,
  onSave,
  onEditItem,
  onRenamed,
}: {
  p: PartnerStat;
  prof: PartnerProfile;
  tag: [string, string, string];
  group: string;
  users: { id: number; name: string }[];
  mobile?: boolean;
  canEdit: boolean;
  onEdit: (r: EditReq) => void;
  onSave: (n: Partial<PartnerProfile>, msg: string) => void;
  onEditItem: (leaf: string, key?: string) => void;
  onRenamed: (key: string) => void;
}) {
  const [more, setMore] = useState(false);
  const ed = (r: EditReq) => (canEdit ? () => onEdit(r) : undefined);
  const address = [prof.zip, prof.city, prof.address].filter(Boolean).join(' ') + (prof.country && prof.country !== 'Magyarország' ? `, ${prof.country}` : '');
  const followers = prof.followers.map((id) => users.find((u) => u.id === id)?.name || `#${id}`);
  const sec = p.sides.in ? 'in' : 'out';

  const contactCol = (
    <>
      <Group title="Névjegyadatok">
        <Row label="E-mail" value={prof.email} empty="E-mail cím hozzáadása" onClick={ed({ kind: 'field', field: 'email', label: 'E-mail' })}>
          {prof.email && <ActionIcon href={'mailto:' + prof.email} label="E-mail írása" d={IC.mail} />}
        </Row>
        {(prof.billing_email || canEdit) && (
          <Row
            label="Számlázási e-mail"
            value={prof.billing_email}
            empty="Számlázási e-mail hozzáadása"
            onClick={ed({ kind: 'field', field: 'billing_email', label: 'Számlázási e-mail' })}
          >
            {prof.billing_email && <ActionIcon href={'mailto:' + prof.billing_email} label="E-mail írása" d={IC.mail} />}
          </Row>
        )}
        <Row label="Telefon" value={prof.phone} empty="Telefonszám hozzáadása" onClick={ed({ kind: 'field', field: 'phone', label: 'Telefon' })}>
          {prof.phone && (
            <>
              <ActionIcon href={'sms:' + prof.phone.replace(/[^\d+]/g, '')} label="SMS" d={IC.sms} />
              <ActionIcon href={telHref(prof.phone)} label="Hívás" d={IC.phone} />
            </>
          )}
        </Row>
        {(prof.website || canEdit) && (
          <Row label="Weboldal" value={prof.website} empty="Weboldal hozzáadása" onClick={ed({ kind: 'field', field: 'website', label: 'Weboldal' })}>
            {prof.website && (
              <ActionIcon href={/^https?:/.test(prof.website) ? prof.website : 'https://' + prof.website} label="Megnyitás" d={IC.web} external />
            )}
          </Row>
        )}
      </Group>

      <Group title="Kapcsolattartók" right={canEdit ? <LinkBtn onClick={() => onEdit({ kind: 'contact', index: -1 })}>+ Új</LinkBtn> : undefined}>
        {prof.contact && <Row label="Fő kapcsolattartó" value={prof.contact} onClick={ed({ kind: 'field', field: 'contact', label: 'Fő kapcsolattartó' })} />}
        {prof.contacts.map((c, i) => (
          <Row
            key={i}
            label={c.role || 'Kapcsolattartó'}
            value={c.name || c.email || c.phone}
            sub={[c.email, c.phone].filter(Boolean).join(' · ')}
            onClick={ed({ kind: 'contact', index: i })}
          >
            {c.email && <ActionIcon href={'mailto:' + c.email} label="E-mail írása" d={IC.mail} />}
            {c.phone && <ActionIcon href={telHref(c.phone)} label="Hívás" d={IC.phone} />}
          </Row>
        ))}
        {!prof.contact && !prof.contacts.length && (
          <Row label="Kapcsolattartó" value="" empty="Kapcsolattartó hozzáadása" onClick={ed({ kind: 'contact', index: -1 })} />
        )}
      </Group>

      <Group title="Felelősök">
        <Row label="Követők" value={followers.join(', ')} empty="Felelős kiválasztása" onClick={ed({ kind: 'followers' })} chevron={canEdit} />
      </Group>
    </>
  );

  const infoCol = (
    <>
      <Group title="Cím és számlázás">
        <Row label="Cím" value={address.trim()} empty="Cím megadása" onClick={ed({ kind: 'address' })}>
          {address.trim() && (
            <ActionIcon href={'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address)} label="Térkép" d={IC.map} external />
          )}
        </Row>
        <Row
          label="Hivatalos cégnév"
          value={prof.company}
          empty="Cégnév megadása"
          onClick={ed({ kind: 'field', field: 'company', label: 'Hivatalos cégnév' })}
        />
        <Row label="Adószám" value={p.info?.tax_number || ''} empty="a További beállításokban adható meg" />
        {(prof.eu_tax || canEdit) && (
          <Row label="Közösségi adószám" value={prof.eu_tax} empty="Megadás" onClick={ed({ kind: 'field', field: 'eu_tax', label: 'Közösségi adószám' })} />
        )}
        <Row label="Bankszámlaszám" value={prof.bank_account} empty="Megadás" onClick={ed({ kind: 'field', field: 'bank_account', label: 'Bankszámlaszám' })} />
        <Row
          label="Fizetési határidő"
          value={prof.pay_days == null ? '' : `számla kelte + ${prof.pay_days} nap`}
          empty="Megadás"
          onClick={ed({ kind: 'pay_days' })}
        />
      </Group>

      <Group title="Egyéni mezők" right={canEdit ? <LinkBtn onClick={() => onEdit({ kind: 'custom', index: -1 })}>+ Új mező</LinkBtn> : undefined}>
        {prof.custom.map((c, i) => (
          <Row key={i} label={c.label} value={c.value} empty="–" onClick={ed({ kind: 'custom', index: i })} chevron={canEdit} />
        ))}
        {!prof.custom.length && (
          <Row label="pl. beosztás, érdeklődési kör, hogyan talált ránk" value="" empty="Mező hozzáadása" onClick={ed({ kind: 'custom', index: -1 })} />
        )}
      </Group>
      {p.info?.note && (
        <Group title="Megjegyzés">
          <div style={{ padding: '12px 16px', font: `400 15px/1.5 ${FONT}`, color: C.ink, whiteSpace: 'pre-wrap' }}>{p.info.note}</div>
        </Group>
      )}
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* címke: vevő / szállító + kategória */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderTop: `8px solid ${C.bg}`, borderBottom: `8px solid ${C.bg}` }}>
        <span style={{ color: C.navy }}>
          <Svg d={IC.tag} size={22} />
        </span>
        <span style={{ padding: '5px 10px', borderRadius: 6, background: tag[1], color: tag[2], font: `700 14px ${FONT}`, letterSpacing: '.04em' }}>
          {tag[0]}
        </span>
        {group && <span style={{ padding: '5px 10px', borderRadius: 6, background: C.bg, color: C.ink, font: `600 13px ${FONT}` }}>{group}</span>}
        <span style={{ marginLeft: 'auto', font: `500 13px ${FONT}`, color: C.muted, textAlign: 'right' }}>
          {p.sides[sec]?.last12 ? `${fmt(p.sides[sec]!.last12)} Ft · 12 hó` : ''}
        </span>
      </div>
      {mobile ? (
        <>
          {contactCol}
          {infoCol}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '0 28px', alignItems: 'start' }}>
          <div>{contactCol}</div>
          <div>{infoCol}</div>
        </div>
      )}
      {canEdit && (
        <div style={{ borderTop: `8px solid ${C.bg}` }}>
          <button
            type="button"
            onClick={() => setMore((x) => !x)}
            aria-expanded={more}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              border: 0,
              background: '#fff',
              padding: '16px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ flex: 1, font: `600 15.5px ${FONT}`, color: C.navy }}>További beállítások</span>
            <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>név, típus, adószám, fizetési szokás</span>
            <span style={{ color: C.muted, transform: more ? 'rotate(90deg)' : 'none', transition: 'transform .2s ease' }}>
              <Svg d={IC.chev} size={18} />
            </span>
          </button>
          {more && (
            <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column' }}>
              <SecHead>Azonosítás</SecHead>
              <PartnerEditor key={p.key + (p.info?.updated_at || 0)} p={p} part="settings" onSaved={onRenamed} compact={mobile} />
              <PaymentTerms p={p} rows={!mobile} />
              <SecHead>Tervezett tételek</SecHead>
              <PlannedTasks p={p} onEdit={onEditItem} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', background: C.bg }}>
        <span style={{ flex: 1, font: `500 15px ${FONT}`, color: C.muted }}>{title}</span>
        {right}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  sub,
  empty,
  onClick,
  chevron,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  empty?: string;
  onClick?: () => void;
  chevron?: boolean;
  children?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 0 0', borderBottom: `1px solid ${C.line3}`, minHeight: 64 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: 'transparent',
          textAlign: 'left',
          padding: '11px 16px 11px 56px',
          cursor: onClick ? 'pointer' : 'default',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          color: 'inherit',
        }}
      >
        <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>{label}</span>
        <span
          style={{
            font: value ? `500 17px ${FONT}` : `500 15px ${FONT}`,
            color: value ? C.ink : onClick ? C.blueDark : C.faint,
            overflowWrap: 'anywhere',
          }}
        >
          {value || empty || '–'}
        </span>
        {sub && <span style={{ font: `400 13.5px ${FONT}`, color: C.muted, overflowWrap: 'anywhere' }}>{sub}</span>}
      </button>
      {children}
      {chevron && (
        <span style={{ color: C.muted, display: 'grid', placeItems: 'center' }}>
          <Svg d={IC.chev} size={18} />
        </span>
      )}
    </div>
  );
}

function ActionIcon({ href, label, d, external }: { href: string; label: string; d: string; external?: boolean }) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      style={{ width: 44, height: 44, display: 'grid', placeItems: 'center', color: C.blue, borderRadius: 999 }}
    >
      <Svg d={d} size={24} />
    </a>
  );
}

const LinkBtn = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 14px ${FONT}`, cursor: 'pointer', padding: 0 }}
  >
    {children}
  </button>
);

function RoundBtn({ children, label, onClick, flat }: { children: ReactNode; label: string; onClick: () => void; flat?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 44,
        height: 44,
        borderRadius: 999,
        border: 0,
        background: flat ? 'transparent' : C.bg,
        color: C.navy,
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function FabBtn({ children, label, onClick, href }: { children: ReactNode; label: string; onClick?: () => void; href?: string }) {
  const st: CSSProperties = {
    width: 56,
    height: 50,
    borderRadius: 999,
    display: 'grid',
    placeItems: 'center',
    color: '#fff',
    border: 0,
    background: 'transparent',
    cursor: onClick || href ? 'pointer' : 'not-allowed',
    opacity: onClick || href ? 1 : 0.45,
  };
  if (onClick)
    return (
      <button type="button" aria-label={label} title={label} onClick={onClick} style={st}>
        {children}
      </button>
    );
  return href ? (
    <a href={href} aria-label={label} title={label} style={st}>
      {children}
    </a>
  ) : (
    <span role="img" aria-label={label} title={label} style={st}>
      {children}
    </span>
  );
}

const MenuItem = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    className="side-btn-light"
    style={{
      border: 0,
      background: 'transparent',
      textAlign: 'left',
      padding: '11px 12px',
      borderRadius: 10,
      font: `500 15px ${FONT}`,
      color: C.ink,
      cursor: 'pointer',
    }}
  >
    {children}
  </button>
);

function RenameInput({ p, onDone }: { p: PartnerStat; onDone: (key: string | null) => void }) {
  const { run } = useStore();
  const [v, setV] = useState(p.name);
  const save = () => {
    const n = v.replace(/\s+/g, ' ').trim();
    if (!n || n === p.name) return onDone(null);
    let key: string | null = null;
    run(async () => {
      const r = await api<{ key: string }>(`/api/partners/${encodeURIComponent(p.key)}`, { method: 'PUT', body: { name: n } });
      key = r.key;
    }, `Partner átnevezve: ${n}`).then(() => onDone(key));
  };
  return (
    <input
      autoFocus
      aria-label="Partner neve"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') onDone(null);
      }}
      style={{ ...inputStyle, flex: 1, minWidth: 0, height: 48, font: `700 22px ${FONT_H}`, color: C.navy }}
    />
  );
}

// ───────────────────────── szerkesztő ablak ─────────────────────────

function EditDialog({
  req,
  p,
  prof,
  users,
  onClose,
  onSave,
}: {
  req: EditReq;
  p: PartnerStat;
  prof: PartnerProfile;
  users: { id: number; name: string }[];
  onClose: () => void;
  onSave: (n: Partial<PartnerProfile>, msg: string) => void;
}) {
  const blankC: PartnerContact = { name: '', role: '', email: '', phone: '' };
  const [f, setF] = useState<Record<string, string>>(() => {
    if (req.kind === 'field') return { v: String(prof[req.field] || '') };
    if (req.kind === 'address') return { zip: prof.zip, city: prof.city, address: prof.address, country: prof.country };
    if (req.kind === 'pay_days') return { v: prof.pay_days == null ? '' : String(prof.pay_days) };
    if (req.kind === 'contact') return { ...(prof.contacts[req.index] || blankC) } as unknown as Record<string, string>;
    if (req.kind === 'custom') return { ...(prof.custom[req.index] || { label: '', value: '' }) };
    return {};
  });
  const [fol, setFol] = useState<number[]>(prof.followers);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const isNew = (req.kind === 'contact' || req.kind === 'custom') && req.index < 0;

  const title =
    req.kind === 'field'
      ? req.label
      : req.kind === 'address'
        ? 'Cím'
        : req.kind === 'pay_days'
          ? 'Fizetési határidő'
          : req.kind === 'contact'
            ? isNew
              ? 'Új kapcsolattartó'
              : 'Kapcsolattartó'
            : req.kind === 'custom'
              ? isNew
                ? 'Új egyéni mező'
                : 'Egyéni mező'
              : 'Felelősök';

  const save = () => {
    if (req.kind === 'field') onSave({ [req.field]: f.v }, `${req.label} mentve`);
    else if (req.kind === 'address') onSave({ zip: f.zip, city: f.city, address: f.address, country: f.country }, 'cím mentve');
    else if (req.kind === 'pay_days') onSave({ pay_days: f.v === '' ? null : Number(f.v) }, 'fizetési határidő mentve');
    else if (req.kind === 'contact') {
      const c = { name: f.name || '', role: f.role || '', email: f.email || '', phone: f.phone || '' };
      const list = [...prof.contacts];
      if (isNew) list.push(c);
      else list[req.index] = c;
      onSave({ contacts: list }, 'kapcsolattartó mentve');
    } else if (req.kind === 'custom') {
      if (!f.label?.trim()) return;
      const list = [...prof.custom];
      const c = { label: f.label, value: f.value || '' };
      if (isNew) list.push(c);
      else list[req.index] = c;
      onSave({ custom: list }, 'egyéni mező mentve');
    } else onSave({ followers: fol }, 'felelősök mentve');
    onClose();
  };
  const remove = () => {
    if (req.kind === 'contact') onSave({ contacts: prof.contacts.filter((_, i) => i !== req.index) }, 'kapcsolattartó törölve');
    if (req.kind === 'custom') onSave({ custom: prof.custom.filter((_, i) => i !== req.index) }, 'egyéni mező törölve');
    onClose();
  };

  const inp = (k: string, label: string, type = 'text', ph = '') => (
    <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 5, font: `500 13px ${FONT}`, color: C.muted }}>
      {label}
      <input
        value={f[k] || ''}
        onChange={set(k)}
        type={type}
        placeholder={ph}
        inputMode={type === 'tel' ? 'tel' : type === 'number' ? 'numeric' : undefined}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        style={{ ...inputStyle, height: 46, font: `400 16px ${FONT}` }}
      />
    </label>
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: window.innerWidth > 700 ? 'center' : 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div className="cf-fade" onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(20,35,58,.45)' }} />
      <div
        role="dialog"
        aria-label={title}
        className="cf-rise"
        style={{
          position: 'relative',
          width: 'min(100%, 520px)',
          background: '#fff',
          borderRadius: '18px 18px 0 0',
          padding: '18px 18px calc(env(safe-area-inset-bottom) + 18px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxHeight: '88vh',
          overflowY: 'auto',
          ...(window.innerWidth > 700 ? { borderRadius: 18, alignSelf: 'center' } : {}),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <b style={{ flex: 1, font: `700 19px ${FONT_H}`, color: C.navy }}>{title}</b>
          <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>{p.name}</span>
        </div>
        {req.kind === 'field' &&
          inp(
            'v',
            req.label,
            req.field.includes('email') ? 'email' : req.field === 'phone' ? 'tel' : 'text',
            req.field === 'phone' ? '+36 20 123 4567' : req.field === 'website' ? 'pelda.hu' : '',
          )}
        {req.kind === 'address' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10 }}>
              {inp('zip', 'Irányítószám')}
              {inp('city', 'Település')}
            </div>
            {inp('address', 'Utca, házszám')}
            {inp('country', 'Ország')}
          </>
        )}
        {req.kind === 'pay_days' && inp('v', 'Napok száma a számla keltétől', 'number', 'pl. 8')}
        {req.kind === 'contact' && (
          <>
            {inp('name', 'Név')}
            {inp('role', 'Beosztás / szerep', 'text', 'pl. cégvezető, könyvelő')}
            {inp('email', 'E-mail', 'email')}
            {inp('phone', 'Telefon', 'tel', '+36 20 123 4567')}
          </>
        )}
        {req.kind === 'custom' && (
          <>
            {inp('label', 'Mező neve', 'text', 'pl. Érdeklődési kör')}
            {inp('value', 'Érték')}
          </>
        )}
        {req.kind === 'followers' && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {users.map((u) => (
              <label
                key={u.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: `1px solid ${C.line3}`, font: `500 16px ${FONT}` }}
              >
                <input
                  type="checkbox"
                  checked={fol.includes(u.id)}
                  onChange={(e) => setFol(e.target.checked ? [...fol, u.id] : fol.filter((x) => x !== u.id))}
                  style={{ width: 20, height: 20 }}
                />
                {u.name}
              </label>
            ))}
            {!users.length && <span style={{ color: C.muted, font: `400 14px ${FONT}` }}>Nincs felhasználó.</span>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          {(req.kind === 'contact' || req.kind === 'custom') && !isNew && (
            <button type="button" onClick={remove} style={{ ...dlgBtn, background: C.negBg, color: C.neg }}>
              Törlés
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ ...dlgBtn, background: C.bg, color: C.ink }}>
            Mégse
          </button>
          <button type="button" onClick={save} style={{ ...dlgBtn, background: C.blue, color: '#fff' }}>
            Mentés
          </button>
        </div>
      </div>
    </div>
  );
}
const dlgBtn: CSSProperties = { height: 44, border: 0, borderRadius: 999, padding: '0 20px', font: `600 15px ${FONT}`, cursor: 'pointer' };

// ───────────────────────── Idővonal ─────────────────────────

type Ev = { date: string; kind: 'inv' | 'pay' | 'task' | 'plan'; title: string; sub?: string; amount?: number; tone?: 'neg' | 'ok' | 'muted' };

function Timeline({ p }: { p: PartnerStat }) {
  const { data, ix } = useStore();
  const [n, setN] = useState(40);
  const evs = useMemo(() => {
    const out: Ev[] = [];
    for (const i of p.invoices) {
      const d = i.doc;
      if (d.invoice_date)
        out.push({
          date: d.invoice_date,
          kind: 'inv',
          title: `Számla kiállítva${d.number ? ' · ' + d.number : ''}`,
          sub: d.due_date ? `határidő ${d.due_date.replace(/-/g, '.')}.` : undefined,
          amount: d.gross,
        });
      if (d.paid_date)
        out.push({
          date: d.paid_date,
          kind: 'pay',
          title: 'Számla kifizetve',
          sub: i.lateDays ? `${i.lateDays} nap késéssel` : 'határidőben',
          amount: d.gross,
          tone: i.lateDays && i.lateDays > 0 ? 'neg' : 'ok',
        });
    }
    const invPaid = new Set(p.invoices.map((i) => i.doc.paid_date).filter(Boolean));
    for (const e of p.past)
      if (e.kind === 'actual' && !invPaid.has(e.date))
        out.push({
          date: e.date,
          kind: 'pay',
          title: ix.sectionOf(e.leaf_id) === 'in' ? 'Befizetés' : 'Kifizetés',
          sub: e.name || undefined,
          amount: Math.abs(e.amount),
          tone: 'ok',
        });
    for (const t of data.tasks || [])
      if (t.partner_key === p.key && t.status === 'kesz')
        out.push({
          date: t.done_at ? new Date(t.done_at).toISOString().slice(0, 10) : t.due_date,
          kind: 'task',
          title: `${TASK_TYPES.find((x) => x[0] === t.type)?.[1] || 'Feladat'} · ${t.title}`,
          sub: 'elvégezve',
          tone: 'muted',
        });
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }, [p, data.tasks, ix]);
  const upcoming = p.future
    .filter((e) => e.kind === 'plan' && !e.done)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);

  let lastYm = '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <b style={{ font: `700 19px ${FONT_H}`, color: C.navy, marginBottom: 6 }}>Idővonal</b>
      {upcoming.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 8 }}>
          <span style={{ font: `600 12px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.blue, margin: '4px 0 6px' }}>Következik</span>
          {upcoming.map((e) => (
            <EvRow
              key={e.id}
              ev={{
                date: e.date,
                kind: 'plan',
                title: e.name || 'Tervezett tétel',
                sub: e.date < data.today ? 'lejárt' : e.tentative ? 'ajánlat' : 'tervezett',
                amount: Math.abs(e.amount),
                tone: e.date < data.today ? 'neg' : 'muted',
              }}
            />
          ))}
        </div>
      )}
      {evs.slice(0, n).map((ev, i) => {
        const ym = ev.date.slice(0, 7);
        const head = ym !== lastYm;
        lastYm = ym;
        return (
          <div key={i}>
            {head && (
              <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted, margin: '12px 0 6px' }}>
                {monthLong(ymOf(ev.date))}
              </div>
            )}
            <EvRow ev={ev} />
          </div>
        );
      })}
      {!evs.length && <span style={{ font: `400 14px ${FONT}`, color: C.muted }}>Még nincs esemény (számla, fizetés, elvégzett feladat).</span>}
      {evs.length > n && (
        <button type="button" onClick={() => setN(n + 40)} style={{ ...dlgBtn, alignSelf: 'center', marginTop: 10, background: C.bg, color: C.navy }}>
          Korábbiak ({evs.length - n})
        </button>
      )}
    </div>
  );
}

const EV_ICON: Record<Ev['kind'], [string, string]> = {
  inv: ['M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4', C.blue],
  pay: ['M4 12l5 5L20 6', '#1BAF7A'],
  task: ['M9 11l2.5 2.5L16 9M4 4h16v16H4z', '#6250D6'],
  plan: ['M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z', '#EB6834'],
};

function EvRow({ ev }: { ev: Ev }) {
  const [d, col] = EV_ICON[ev.kind];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr) auto', gap: 12, alignItems: 'start', position: 'relative', paddingBottom: 14 }}>
      <span style={{ position: 'absolute', left: 16, top: 34, bottom: 0, width: 2, background: C.line3 }} />
      <span
        style={{ width: 34, height: 34, borderRadius: 999, background: col + '1f', color: col, display: 'grid', placeItems: 'center', position: 'relative' }}
      >
        <Svg d={d} size={18} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingTop: 2 }}>
        <b style={{ font: `600 15px ${FONT}`, color: C.ink, overflowWrap: 'anywhere' }}>{ev.title}</b>
        <span style={{ font: `400 13px ${FONT}`, color: ev.tone === 'neg' ? C.neg : C.muted }}>
          {ev.date.replace(/-/g, '.')}.{ev.sub ? ` · ${ev.sub}` : ''}
        </span>
      </span>
      {ev.amount != null && (
        <b style={{ font: `700 15px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums', paddingTop: 2, whiteSpace: 'nowrap' }}>{fmt(ev.amount)} Ft</b>
      )}
    </div>
  );
}

// ───────────────────────── Értékesítések (mobil) ─────────────────────────

function MobileSales({ p, onNewItem, onEditItem }: { p: PartnerStat; onNewItem: (leaf: string) => void; onEditItem: (leaf: string, key?: string) => void }) {
  const [v, setV] = useState<'pay' | 'srv'>('pay');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: '0 16px' }}>
        {(
          [
            ['pay', 'Számlák, fizetések'],
            ['srv', 'Szolgáltatások'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setV(k)}
            style={{
              height: 36,
              borderRadius: 999,
              border: `1px solid ${v === k ? C.navy : C.line2}`,
              background: v === k ? C.navy : '#fff',
              color: v === k ? '#fff' : C.ink,
              font: `600 13.5px ${FONT}`,
            }}
          >
            {l}
          </button>
        ))}
      </div>
      {v === 'pay' ? (
        <MobilePartnerScreen p={p} embedded onClose={() => undefined} onNewItem={onNewItem} onEditItem={onEditItem} />
      ) : (
        <div style={{ padding: '0 16px' }}>
          <PartnerBillingTab p={p} compact />
        </div>
      )}
    </div>
  );
}
