(async () => {
  const tk = localStorage.getItem('token');
  if (!tk) return 'LOGIN';
  const B = 'https://standalone-backend.aggreg8.hu';
  const get = async (p) => {
    const r = await fetch(B + p, { headers: { Authorization: 'Bearer ' + tk } });
    if (r.status === 401) throw new Error('LOGIN');
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
    return r.json();
  };
  const arr = (j) => (Array.isArray(j) ? j : j && (j.data || j.items || j.results || j.transactions || j.consents)) || [];
  let tx = [], p = 1, tp = 1;
  do {
    const j = await get('/transactions?page=' + p);
    tx = tx.concat(arr(j));
    tp = (j && j.meta && (j.meta.totalPages || j.meta.total_pages)) || 1;
    p++;
  } while (p <= tp && p <= 80);
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
  const out = {
    transactions: tx.map((t) => {
      if (!t || typeof t !== 'object' || t.account) return t;
      const a = findAcc(Object.fromEntries(Object.entries(t).filter(([k]) => k !== '_id' && k !== 'id')));
      return a ? Object.assign({}, t, { account: a }) : t;
    }),
  };
  const name = 'aggreg8-tranzakciok-' + new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-') + '.json';
  const u = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
  const dates = tx.map((t) => String((t && (t.bookingDate || t.valueDate || t.date)) || '').slice(0, 10)).filter(Boolean).sort();
  return 'OK ' + tx.length + ' tétel (' + (dates[0] || '?') + ' – ' + (dates[dates.length - 1] || '?') + '), ' + out.transactions.filter((t) => t && t.account).length + ' számlához rendelve, fájl: ' + name;
})();
