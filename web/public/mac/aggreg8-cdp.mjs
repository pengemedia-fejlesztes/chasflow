// Cashflow – aggreg8 banki szinkron a Chrome hivatalos fejlesztői vezérlőfelületén (CDP) keresztül.
// Láthatatlan háttérlapon dolgozik: belépés (Google „Folytatás … néven” is, a Chrome FedCM-automatizálásával),
// szinkron (BinX, MagNet), letöltés, feltöltés a cashflow tervezőbe, majd a lap bezárása.
// Nem kell hozzá Kisegítő engedély, AppleScript vagy egérkattintás.
// Böngésző: saját, külön „Cashflow-Chrome” példány (külön profillal, 9339-es port) – ebben egyszer be kell lépni a
// laszlo.nagy@360-marketing.eu Google-fiókkal (jelszó + kód, ezt a Google csak embertől fogadja el); utána minden automatikus.
// Kimenet: az utolsó sor egy JSON: {ok, msg, steps}
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const env = process.env;
const STATE = env.CF_STATE || `${homedir()}/Library/Application Support/cashflow-aggreg8`;
const CF_URL = env.CF_URL || 'https://cashflow-tervezo.pengemedia.workers.dev';
const TOKEN = env.CF_TOKEN || '';
const AGG = env.AGG_ORIGIN || 'https://standalone.aggreg8.hu';
const BACKEND = env.AGG_BACKEND || 'https://standalone-backend.aggreg8.hu';
const PORTS = (env.CDP_PORTS || '9339').split(',').map(Number);
const OWN_PORT = Number(env.CDP_OWN_PORT || 9339);
const CHROME = env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WANT = (env.CF_GOOGLE_ACCOUNT || '').toLowerCase();
const DOWNLOADS = env.CF_DOWNLOADS || `${homedir()}/Downloads`;
const GOOGLE = new RegExp(env.GOOGLE_RE || 'accounts\\.google\\.com');

const steps = [];
const step = (s) => {
  steps.push(s);
  console.error(new Date().toISOString().slice(11, 19), s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (ok, msg) => {
  console.log(JSON.stringify({ ok, msg, steps }));
  process.exit(ok ? 0 : 1);
};
// a teljes futás felső korlátja (ne maradjon beragadva)
setTimeout(() => done(false, 'Időtúllépés (10 perc).'), 10 * 60_000).unref();

async function getJson(url, ms = 2000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return r.json();
}

async function findBrowser() {
  for (const p of PORTS) {
    try {
      const v = await getJson(`http://127.0.0.1:${p}/json/version`);
      if (v.webSocketDebuggerUrl) return { port: p, ws: v.webSocketDebuggerUrl, own: p === OWN_PORT };
    } catch {}
  }
  return null;
}

async function launchOwn() {
  const dir = `${STATE}/chrome-profil`;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(CHROME)) throw new Error('Nem találom a Google Chrome-ot.');
  const extra = env.CHROME_ARGS ? env.CHROME_ARGS.split(' ') : [];
  const p = spawn(
    CHROME,
    [`--remote-debugging-port=${OWN_PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', ...extra, 'about:blank'],
    { detached: true, stdio: 'ignore' },
  );
  p.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const v = await getJson(`http://127.0.0.1:${OWN_PORT}/json/version`);
      if (v.webSocketDebuggerUrl) return { port: OWN_PORT, ws: v.webSocketDebuggerUrl, own: true, launched: true };
    } catch {}
  }
  throw new Error('A saját Chrome-példány nem indult el.');
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('CDP kapcsolódási hiba'));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) this.handlers.forEach((h) => h(m));
    };
  }
  send(method, params = {}, sessionId, ms = 30000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method}: időtúllépés`));
      }, ms);
    });
  }
  on(fn) {
    this.handlers.push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function main() {
  if (!TOKEN) done(false, 'Nincs feltöltési kulcs.');
  let br = await findBrowser();
  if (!br) {
    step('nincs futó vezérelhető Chrome – saját példány indítása');
    br = await launchOwn();
  }
  step(`böngésző: ${br.own ? 'saját példány' : 'robot-Chrome'} (port ${br.port})`);
  const c = new CDP(br.ws);
  await c.ready;

  // felugró Google-ablakok figyelése
  const popups = [];
  await c.send('Target.setDiscoverTargets', { discover: true });
  // csak valódi lapok/ablakok (a beágyazott Google-gomb iframe nem felugró ablak)
  let watch = false;
  let ourTarget = '';
  c.on((m) => {
    if (m.method === 'Target.targetDestroyed') {
      const i = popups.indexOf(m.params.targetId);
      if (i >= 0) popups.splice(i, 1);
      return;
    }
    if (m.method !== 'Target.targetCreated' && m.method !== 'Target.targetInfoChanged') return;
    const ti = m.params.targetInfo;
    if (watch && m.method === 'Target.targetCreated') step(`új cél: ${ti.type} ${(ti.url || '').slice(0, 80)}`);
    // a mi lapunkból nyílt új ablak (a Google belépőablaka), vagy bármely Google-belépő lap
    if (ti.type === 'page' && ti.targetId !== ourTarget && (ti.openerId === ourTarget || GOOGLE.test(ti.url || '')) && !popups.includes(ti.targetId))
      popups.push(ti.targetId);
  });

  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', background: true });
  ourTarget = targetId;
  // a lap bezárása, és a böngésző letöltési beállításának visszaállítása (a robot-Chrome-ot ne zavarjuk)
  const closeTab = async () => {
    await c.send('Target.closeTarget', { targetId }).catch(() => {});
    await c.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
  };
  try {
    const { sessionId: S } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, S);
    await c.send('Runtime.enable', {}, S);
    // a letöltött fájl a Letöltések mappába kerüljön
    await c.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: false }).catch(() => {});
    // háttérlapon is legyen „látható” és fókuszált (a gombok, időzítők így normálisan működnek)
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }, S).catch(() => {});
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, S).catch(() => {});

    const evaluate = async (expression, ms = 30000) => {
      const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S, ms);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const href = () => evaluate('location.href').catch(() => '');
    const go = async (path) => {
      await c.send('Page.navigate', { url: AGG + path }, S);
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const st = await evaluate('document.readyState').catch(() => '');
        if (st === 'complete') break;
      }
      await sleep(1500); // az Angular-alkalmazás felépül, esetleg átirányít
      return href();
    };
    const loggedOut = (u) => /\/login/.test(u) || !u.startsWith(AGG);

    // 1) belépés
    let u = await go('/synchronizations');
    step(`lap: ${u.replace(AGG, '')}`);
    if (loggedOut(u)) {
      watch = true;
      const ok = await login(c, S, evaluate, href, popups);
      watch = false;
      if (!ok) {
        if (br.own) {
          const txt = await evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`).catch(() => '');
          step(`belépő lap: ${txt}`);
          // a Google jelszót/kódot kér: az ablakot nyitva hagyjuk és előre hozzuk – ezt egyszer embernek kell megadnia
          await c.send('Target.activateTarget', { targetId }).catch(() => {});
          done(false, 'Egyszeri belépés kell: a megnyílt Cashflow-Chrome ablakban lépj be az aggreg8-ba a laszlo.nagy@360-marketing.eu Google-fiókkal (jelszó + kód). Utána minden magától megy.');
        }
        await closeTab();
        done(false, 'Az aggreg8-ba nem sikerült automatikusan belépni (lásd a lépéseket).');
      }
      u = await go('/synchronizations');
      step(`lap: ${u.replace(AGG, '')}`);
    }

    // ellenőrzés: a belépett aggreg8-fiókban megvan-e a BinX és a MagNet kapcsolat (különben semmit nem töltünk fel)
    const banks = await evaluate(
      `(async () => { const lbl = (b) => { for (let e = b; e && e !== document.body; e = e.parentElement) { const t = (e.innerText || '').toLowerCase(), x = /binx/.test(t), m = /magnet/.test(t); if (x !== m) return x ? 'BinX' : 'MagNet'; if (x && m) break; } return ''; };
        for (let i = 0; i < 20; i++) { const b = [...document.querySelectorAll('button.btn-sync')].map(lbl).filter(Boolean); if (b.length) return [...new Set(b)].join(','); await new Promise((r) => setTimeout(r, 1000)); }
        return ''; })()`,
      60000,
    ).catch(() => '');
    step(`bankkapcsolatok: ${banks || 'nincs'}`);
    if (!/BinX/.test(banks) && !/MagNet/.test(banks)) {
      await closeTab();
      done(false, 'A belépett aggreg8-fiókban nem látom a BinX/MagNet kapcsolatot – semmit nem töltöttem fel (lásd a lépéseket).');
    }

    // 2) szinkron bankonként
    const sync = [];
    for (const bank of ['BinX', 'MagNet']) {
      const r = await evaluate(
        `(async () => {
          const q = () => { let b = [...document.querySelectorAll('app-bac-list button.btn-sync')]; if (!b.length) b = [...document.querySelectorAll('button.btn-sync')]; return b; };
          const lbl = (b) => { for (let e = b; e && e !== document.body; e = e.parentElement) { const t = (e.innerText || '').toLowerCase(), x = /binx/.test(t), m = /magnet/.test(t); if (x !== m) return x ? 'BinX' : 'MagNet'; if (x && m) break; } return ''; };
          let b = null;
          for (let i = 0; i < 30 && !(b = q().find((x) => lbl(x) === '${bank}' && !x.disabled)); i++) await new Promise((r) => setTimeout(r, 1000));
          if (!b) return 'nincs gomb';
          const n = () => document.body.innerText.split('Sikeres szinkroniz').length;
          // az üzenetek száma a kattintás óta látott legkisebbhez képest nő (az előző bank üzenete közben eltűnhet)
          let base = n();
          let res = '';
          const mo = new MutationObserver(() => { if (res) return; const k = n(); if (k < base) base = k; else if (k > base) res = 'OK'; else if (/sikertelen|hiba történt/i.test(document.body.innerText)) res = 'HIBA'; });
          mo.observe(document.body, { childList: true, subtree: true, characterData: true });
          b.scrollIntoView({ block: 'center' });
          b.click();
          for (let i = 0; i < 180 && !res; i++) await new Promise((r) => setTimeout(r, 500));
          mo.disconnect();
          return res || 'időtúllépés';
        })()`,
        120000,
      ).catch((e) => 'hiba: ' + e.message);
      sync.push(`${bank}: ${r}`);
      step(`szinkron ${bank}: ${r}`);
    }

    // 3) letöltés (csak az új tételek: a cashflow megadja a kezdő dátumot; hétfő hajnalban teljes lista)
    let since = '';
    const now = new Date();
    if (!(now.getDay() === 1 && now.getHours() < 7)) {
      try {
        const s = await (await fetch(`${CF_URL}/api/ingest/status`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20000) })).json();
        since = s.since || '';
      } catch {}
    }
    step(`kezdő dátum: ${since || 'teljes lista'}`);
    await go('/transactions');
    let exp = env.EXPORT_JS_FILE
      ? readFileSync(env.EXPORT_JS_FILE, 'utf8')
      : await (await fetch(`${CF_URL}/mac/aggreg8-export.js`, { signal: AbortSignal.timeout(20000) })).text();
    exp = exp.trim().replace(/;$/, '').replaceAll('https://standalone-backend.aggreg8.hu', BACKEND);
    const summary = await evaluate(`window.__cf_since = ${JSON.stringify(since)}; window.__cf_nofile = true; ${exp}`, 180000).catch((e) => 'HIBA ' + e.message);
    step(`letöltés: ${String(summary).slice(0, 200)}`);
    if (!String(summary).startsWith('OK')) {
      await closeTab();
      done(false, /LOGIN/.test(String(summary)) ? 'Az aggreg8 kiléptetett a letöltés közben.' : `Letöltési hiba: ${summary}`);
    }
    const data = await evaluate('(() => { const d = window.__cf_data || ""; delete window.__cf_data; return d; })()', 60000);

    // 4) feltöltés a cashflow tervezőbe
    const up = await fetch(`${CF_URL}/api/ingest/aggreg8`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Requested-With': 'cashflow', 'Content-Type': 'application/json' },
      body: data,
      signal: AbortSignal.timeout(120000),
    });
    const ur = await up.json().catch(() => ({}));
    await closeTab();
    if (!ur.ok) done(false, `Feltöltési hiba: ${JSON.stringify(ur).slice(0, 200)}`);
    const n = (ur.accounts || []).reduce((s, a) => s + (a.inbox || 0) + (a.auto || 0), 0);
    done(true, `Szinkron: ${sync.join('; ')}. Letöltés: ${String(summary).replace(/^OK /, '')}. Új tétel: ${n}.`);
  } catch (e) {
    await closeTab();
    throw e;
  } finally {
    c.close();
  }
}

// Belépés: „Bejelentkezés mint …” Google-gomb (beágyazott Google-elem) → a Chrome FedCM-ablaka vagy felugró Google-ablak
async function login(c, S, evaluate, href, popups) {
  const AGGRE = new RegExp('^' + AGG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // akkor vagyunk bent, ha az aggreg8 már elmentette a belépést (token a böngészőben), nem elég az, hogy elhagytuk a /login-t
  const isIn = async () => {
    const u = await href();
    if (!AGGRE.test(u) || /\/login/.test(u)) return false;
    for (let i = 0; i < 20; i++) {
      if (await evaluate(`!!localStorage.getItem('token')`).catch(() => false)) return true;
      await sleep(1000);
      if (/\/login/.test(await href())) return false;
    }
    return false;
  };
  // FedCM: a Chrome beépített „Folytatás … néven” ablaka – hivatalos automatizálással
  let fedcm = '';
  // a FedCM-ablakot a beágyazott Google-gomb (iframe) kéri – ezért a lap összes beágyazott keretére is bekapcsoljuk
  const fed = async (sid, what) => {
    try {
      await c.send('FedCm.enable', { disableRejectionDelay: true }, sid);
      step(`FedCM figyelés: ${what}`);
    } catch (e) {
      step(`FedCM figyelés nem megy (${what}): ${e.message}`);
    }
  };
  await fed(S, 'lap');
  c.on((m) => {
    if (m.method === 'Target.attachedToTarget' && m.sessionId === S) fed(m.params.sessionId, `${m.params.targetInfo.type} ${(m.params.targetInfo.url || '').slice(0, 60)}`);
  });
  await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, S).catch((e) => step('beágyazott keretek: ' + e.message));
  c.on(async (m) => {
    if (m.method !== 'FedCm.dialogShown') return;
    const S2 = m.sessionId;
    const p = m.params;
    try {
      if (p.dialogType === 'AccountChooser' || p.dialogType === 'AutoReauthn') {
        let i = (p.accounts || []).findIndex((a) => WANT && String(a.email).toLowerCase() === WANT);
        if (i < 0) i = 0;
        await c.send('FedCm.selectAccount', { dialogId: p.dialogId, accountIndex: i }, S2);
        fedcm = `fiók: ${p.accounts?.[i]?.email || i}`;
      } else if (p.dialogType === 'ConfirmIdpLogin') {
        await c.send('FedCm.clickDialogButton', { dialogId: p.dialogId, dialogButton: 'ConfirmIdpLoginContinue' }, S2);
        fedcm = 'Google-belépés megerősítve';
      } else fedcm = `ismeretlen ablak: ${p.dialogType}`;
    } catch (e) {
      fedcm = 'hiba: ' + e.message;
    }
    step(`belépés (Chrome-ablak): ${fedcm}`);
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await isIn()) return true;
    // a Google-gomb (iframe) közepe – a CDP-s kattintás valódi felhasználói kattintásnak számít, beágyazott elemen is
    const r = await evaluate(
      `(() => { const f = [...document.querySelectorAll('iframe')].find((e) => new RegExp(${JSON.stringify(env.GSI_RE || 'accounts\\.google\\.com/gsi')}).test(e.src) && e.getBoundingClientRect().width > 0); if (!f) return null; f.scrollIntoView({ block: 'center' }); const b = f.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 120), y: b.top + b.height / 2 }; })()`,
    ).catch(() => null);
    if (!r && GOOGLE.test(await href())) {
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (await isIn()) {
          step('belépés: sikeres');
          return true;
        }
        if (i % 3 === 2) {
          const w = await handlePopup(c, null, S);
          if (w === 'JELSZO') {
            step('belépés: a Google jelszót kér (egyszeri belépés)');
            return false;
          }
        }
      }
      continue;
    }
    if (!r) {
      const txt = await evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)`).catch(() => '');
      step(`belépés: nem látom a Google-gombot (${await href()}: ${txt})`);
      for (let i = 0; i < 6; i++) {
        await sleep(1000);
        if (await isIn()) return true;
      }
      continue;
    }
    step(`belépés: Google-gomb megnyomása (${attempt}. próba)`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }, S);
    // várakozás: FedCM-ablak (automatikusan kezeljük), felugró Google-ablak, vagy közvetlen belépés
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await isIn()) {
        step('belépés: sikeres');
        return true;
      }
      const pid = popups[popups.length - 1];
      if (pid && i % 3 === 2) await handlePopup(c, pid);
      // háttérlapból a Google nem nyit felugró ablakot, hanem magát a lapot viszi a belépőoldalára
      const cur = await href();
      if (GOOGLE.test(cur) && i % 3 === 2) {
        const w = await handlePopup(c, null, S);
        if (w === 'JELSZO') {
          step('belépés: a Google jelszót kér (egyszeri belépés)');
          return false;
        }
      }
      if (i === 5 && !pid && !fedcm && !GOOGLE.test(await href())) step('belépés: 5 mp után sincs Google-ablak');
    }
  }
  step('belépés: nem sikerült' + (fedcm ? ` (${fedcm})` : ''));
  return false;
}

// Felugró Google-ablak (régebbi belépési mód): fiók kiválasztása / Folytatás – CDP-s kattintással
const pressed = {};
async function handlePopup(c, targetId, existingSession) {
  try {
    const P = existingSession || (await c.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const r = await c.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const want = ${JSON.stringify(WANT)};
          const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
          const pw = document.querySelector('input[type=password]');
          if (pw && vis(pw)) return { what: 'JELSZO' };
          const em = document.querySelector('input[type=email]');
          if (em && vis(em) && !em.value) return { what: 'EMAIL' };
          const at = (e, what) => { e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { what, x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
          const acc = [...document.querySelectorAll('[data-identifier],[data-email]')].filter(vis);
          const id = (e) => (e.getAttribute('data-identifier') || e.getAttribute('data-email') || '').toLowerCase();
          const a = acc.find((e) => want && id(e) === want) || (acc.length === 1 ? acc[0] : null);
          if (a) return at(a, 'fiók ' + id(a));
          // a fiók az e-mail-címe szövege alapján (a Google fiókválasztója nem mindig jelöli adat-attribútummal)
          const email = want || '@';
          // a kívánt fiók; ha az nincs a listában és csak egy fiók van, az (a bankkapcsolatokat belépés után ellenőrizzük)
          const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const mails = [];
          let tn;
          while ((tn = tw.nextNode())) {
            const t = (tn.nodeValue || '').trim().toLowerCase();
            if (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(t) && tn.parentElement && vis(tn.parentElement)) mails.push({ t, el: tn.parentElement });
          }
          const pick = mails.find((m) => want && m.t === want) || (mails.length === 1 ? mails[0] : null);
          if (pick) {
            const row = pick.el.closest('li,[role=link],[role=button],[data-authuser],[tabindex]') || pick.el;
            return at(row, 'fiók ' + pick.t);
          }
          const btn = [...document.querySelectorAll('button,[role=button]')].filter(vis).find((e) => /^(folytatás|continue|tovább|confirm|megerősítés|engedélyezés|allow)/i.test((e.innerText || '').trim()));
          if (btn) return at(btn, 'gomb ' + btn.innerText.trim().slice(0, 30));
          return { what: 'SEMMI: ' + (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
        })()`,
        returnByValue: true,
      },
      P,
    );
    const v = r.result?.value || {};
    pressed[v.what] = (pressed[v.what] || 0) + 1;
    if (pressed[v.what] > 3 && v.x !== undefined) return 'ISMETLES';
    step(`belépés (Google-ablak): ${v.what}`);
    if (v.x !== undefined)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await c.send('Input.dispatchMouseEvent', { type, x: v.x, y: v.y, button: 'left', clickCount: 1 }, P);
    if (v.what === 'EMAIL' && WANT) {
      // a Google az e-mail-címet kéri: beírja és Tovább (jelszót soha nem ír be)
      await c.send('Runtime.evaluate', { expression: `(() => { const e = document.querySelector('input[type=email]'); e.focus(); e.select(); })()` }, P);
      await c.send('Input.insertText', { text: WANT }, P);
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, P);
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, P);
      step('belépés (Google): e-mail-cím megadva');
    }
    if (!existingSession) await c.send('Target.detachFromTarget', { sessionId: P }).catch(() => {});
    return v.what;
  } catch (e) {
    step('belépés (Google-ablak): ' + e.message);
  }
}

main().catch((e) => done(false, 'Hiba: ' + e.message));
