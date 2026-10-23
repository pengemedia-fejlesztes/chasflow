(async () => {
  const tk = localStorage.getItem('token');
  if (!tk) return 'LOGIN';
  const B = 'https://standalone-backend.aggreg8.hu';
  const get = async (p, soft) => {
    const r = await fetch(B + p, { headers: { Authorization: 'Bearer ' + tk } });
    if (r.status === 401) throw new Error('LOGIN');
    if (soft && (r.status === 404 || r.status === 400)) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
    return r.json();
  };
  const arr = (j) => (Array.isArray(j) ? j : j && (j.data || j.items || j.results || j.transactions || j.consents)) || [];
  // lapozás: 0-tól vagy 1-től számozott oldalak; 404 → egyszer újrapróbálja, utána vége; azonosító szerint egyszer
  // csak az új tételek: a cashflow tervező utolsó banki tétele előtti 7. naptól (window.__cf_since); üres → teljes lista
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(window.__cf_since || '')) ? window.__cf_since : '';
  const dayOf = (t) => String((t && (t.bookingDate || t.valueDate || t.date)) || '').slice(0, 10);
  const tx = [], seen = new Set(), pages = [];
  let tp = 0;
  for (let p = 0; p <= 80; p++) {
    let j = await get('/transactions?page=' + p, true);
    if (!j && p > 0 && (!tp || p <= tp)) {
      await new Promise((r) => setTimeout(r, 2000));
      j = await get('/transactions?page=' + p, true);
    }
    if (!j) {
      if (p === 0) continue;
      break;
    }
    const items = arr(j);
    let fresh = 0;
    for (const t of items) {
      const id = t && (t._id || t.id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      tx.push(t);
      fresh++;
    }
    pages.push(p + ':' + fresh);
    // a lista a legújabbal kezdődik: ha ezen az oldalon már a határnál régebbi tétel is van, nem kell tovább lapozni
    const days = items.map(dayOf).filter(Boolean);
    if (since && days.length && days.some((d) => d < since)) break;
    const m = (j && j.meta) || {};
    tp = m.totalPages || m.total_pages || m.lastPage || m.pageCount || tp;
    if (!items.length || (!fresh && p > 1)) break;
    if (tp && p >= tp) break;
  }
  let cons = [];
  try { cons = arr(await get('/bank-access-consents')); } catch (e) {}
  const IB = /^HU\d{2}[0-9 ]{20,34}$/;
  const ibansIn = (o, d = 0, out = []) => {
    if (typeof o === 'string') { if (IB.test(o.trim())) out.push(o.replace(/\s/g, '')); }
    else if (o && typeof o === 'object' && d < 6) Object.values(o).forEach((v) => ibansIn(v, d + 1, out));
    return out;
  };
  // azonosító → saját IBAN (a bankkapcsolatokból); csak ahol egyértelmű
  const map = {};
  const mapIds = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 5) return;
    const ib = [...new Set(ibansIn(o))];
    if (ib.length === 1) ['_id', 'id', 'accountId', 'consentId', 'resourceId'].forEach((k) => { if (typeof o[k] === 'string' || typeof o[k] === 'number') map[String(o[k])] = ib[0]; });
    Object.values(o).forEach((v) => mapIds(v, d + 1));
  };
  cons.forEach((c) => mapIds(c));
  const findAcc = (o, d = 0) => {
    if ((typeof o === 'string' || typeof o === 'number') && map[String(o)]) return map[String(o)];
    if (o && typeof o === 'object' && d < 4) for (const v of Object.values(o)) { const a = findAcc(v, d + 1); if (a) return a; }
    return null;
  };
  const keep = since && tx.some((t) => dayOf(t)) ? tx.filter((t) => !dayOf(t) || dayOf(t) >= since) : tx;
  const out = {
    transactions: keep.map((t) => {
      if (!t || typeof t !== 'object' || t.account) return t;
      const a = findAcc(Object.fromEntries(Object.entries(t).filter(([k]) => k !== '_id' && k !== 'id')));
      return a ? Object.assign({}, t, { account: a }) : t;
    }),
  };
  const name = 'aggreg8-tranzakciok-' + new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-') + '.json';
  window.__cf_data = JSON.stringify(out);
  // automatikus futásnál nincs fájl a Letöltésekben (a szinkron közvetlenül tölt fel); kézi futtatásnál letölti
  if (!window.__cf_nofile) {
    const u = URL.createObjectURL(new Blob([window.__cf_data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  const dates = keep.map(dayOf).filter(Boolean).sort();
  return 'OK ' + keep.length + ' tétel' + (since ? ', ' + since + ' óta' : ', teljes lista') + ' (' + (dates[0] || '?') + ' – ' + (dates[dates.length - 1] || '?') + '), ' + out.transactions.filter((t) => t && t.account).length + ' számlához rendelve, oldalak ' + pages.join(' ') + (tp ? '/' + tp : '') + (window.__cf_nofile ? '' : ', fájl: ' + name);
})();
