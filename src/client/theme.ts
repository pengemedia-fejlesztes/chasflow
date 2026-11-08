/*
 * Design tokenek – „Banki főkönyv” arculat: mélykék-grafit alap, meleg papírfelületek, vékony vonalak árnyék helyett.
 * Állapotszínek: bevétel = mélyzöld (inc), kiadás = grafit (ink), lejárt = téglavörös (neg), ajánlat = okker (offer).
 * Minden szín legalább 4.5:1 kontrasztú a saját hátterén (a muted2 / blue2 csak sötét felületen).
 */
export const C = {
  navy: '#14233A', // oldalsáv, sötét kiemelés
  navy2: '#1C2E47',
  navy3: '#2A3F5C',
  blue: '#1F4E79', // elsődleges művelet, fókusz
  blue2: '#A9C8E8', // akcentus sötét felületen
  blueDark: '#1F4E79', // hivatkozás, pozitív kiemelés
  ink: '#1D2430', // szöveg, kiadás
  muted: '#55606D',
  muted2: '#AFBCCB', // halvány szöveg sötét felületen
  faint: '#626A75', // nulla / üres érték (4.8:1 a papíron is)
  line: '#E2DED5',
  line2: '#CCC7BB',
  line3: '#EEEBE4',
  bg: '#F5F3EE', // papír háttér
  bg2: '#E8EEF4', // kijelölt / kiemelt sor
  bg3: '#FAF9F6',
  neg: '#A3392A', // lejárt, negatív
  negLight: '#F0B4A9',
  negBg: '#FAEDE9',
  inc: '#1D6A46', // bevétel
  incBg: '#E7F2EC',
  offer: '#8A5A10', // ajánlat (nem biztos)
  offerBg: '#FBF2DF',
  white: '#fff',
};

export const FONT_H = "'Source Serif 4', Georgia, 'Times New Roman', serif";
export const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

/** térköz-skála (px) */
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
/** betűméret-skála (px): címke · apró · törzs · kiemelt · alcím · cím · oldalcím · nagy szám */
export const FS = { label: 11, xs: 12, sm: 13, md: 14, lg: 16, xl: 20, xxl: 28, num: 24 } as const;
/** sarokkerekítés */
export const R = { sm: 4, md: 6, lg: 8, pill: 999 } as const;
/** árnyékok: a felületeket vonal választja el; árnyék csak a lebegő elemeken */
export const SHADOW = { none: 'none', card: '0 1px 0 rgba(20,35,58,.04)', pop: '0 8px 24px rgba(20,35,58,.16), 0 1px 3px rgba(20,35,58,.08)' } as const;
