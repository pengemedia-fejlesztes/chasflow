// D1-kompatibilis reteg MySQL folott. A Worker kodja valtozatlanul hasznalja:
//   env.DB.prepare(sql).bind(...).all() / .first() / .run()  es  env.DB.batch([...])
// Itt forditjuk at az SQLite-nyelvjarast MySQL-re.
import mysql from 'mysql2/promise';

const RESERVED_UNUSED = ['key', 'keys', 'order', 'groups', 'rank', 'status', 'range', 'read', 'write', 'usage', 'option', 'lines', 'rows', 'partition', 'leave', 'leaves'];

export function translate(sqlIn) {
  let sql = sqlIn;

  // INSERT OR REPLACE / IGNORE
  sql = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'REPLACE INTO');
  sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO');

  // ON CONFLICT(...) DO NOTHING  ->  INSERT IGNORE
  if (/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/i.test(sql)) {
    sql = sql.replace(/\s*ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/gi, '');
    sql = sql.replace(/^\s*INSERT\s+INTO/i, 'INSERT IGNORE INTO');
  }

  // ON CONFLICT(...) DO UPDATE SET x = excluded.y  ->  ON DUPLICATE KEY UPDATE x = VALUES(y)
  sql = sql.replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET/gi, 'ON DUPLICATE KEY UPDATE');
  sql = sql.replace(/\bexcluded\.([A-Za-z_][\w]*)/gi, (m, c) => `VALUES(${quote(c)})`);

  // SQLite datum-aritmetika
  sql = sql.replace(/date\(\s*'now'\s*,\s*'([+-]?\d+)\s+days?'\s*\)/gi, (m, n) => {
    const v = parseInt(n, 10);
    return v < 0 ? `DATE_SUB(CURDATE(), INTERVAL ${-v} DAY)` : `DATE_ADD(CURDATE(), INTERVAL ${v} DAY)`;
  });
  sql = sql.replace(/date\(\s*'now'\s*\)/gi, 'CURDATE()');

  // SQLite sema-lekerdezes -> information_schema
  sql = sql.replace(
    /FROM\s+pragma_table_info\(\s*'(\w+)'\s*\)\s+WHERE\s+name\s*=\s*'(\w+)'/gi,
    (m, tbl, col) => `FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${tbl}' AND column_name = '${col}'`,
  );
  sql = sql.replace(
    /FROM\s+pragma_table_info\(\s*'(\w+)'\s*\)/gi,
    (m, tbl) => `FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${tbl}'`,
  );

  // SQLite rowid -> sajat rid oszlop (entries, leaves, deleted_entries)
  sql = sql.replace(/\browid\b/gi, 'rid');

  // SQLite GLOB -> MySQL REGEXP
  sql = sql.replace(/(NOT\s+)?GLOB\s+'([^']*)'/gi, (m, neg, pat) => `${neg ? 'NOT ' : ''}REGEXP '${globToRegex(pat)}'`);

  // ON DUPLICATE KEY UPDATE ... WHERE <felt>  (SQLite-ban letezik, MySQL-ben nem):
  // minden ertekadast feltetelesse teszunk
  const dupIdx = sql.search(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  if (dupIdx >= 0) {
    const head = sql.slice(0, dupIdx);
    let tail = sql.slice(dupIdx);
    const wm = tail.match(/\sWHERE\s([\s\S]*)$/i);
    if (wm) {
      let cond = wm[1].trim().replace(/;\s*$/, '');
      const assigns = tail.slice(0, wm.index).replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i, '').trim();
      // a feltetelben a tabla-prefixet elhagyjuk (a meglevo sor), az excluded-bol VALUES() lesz
      cond = cond.replace(/\b[A-Za-z_][\w]*\.(?=[A-Za-z_])/g, (mm) => (/^excluded\./i.test(mm) ? mm : ''));
      cond = cond.replace(/excluded\.([A-Za-z_][\w]*)/gi, (mm, c) => `VALUES(${quote(c)})`);
      const parts = [];
      let depth = 0, cur = '';
      for (const ch of assigns) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      const wrapped = parts
        .map((a) => {
          const eq = a.indexOf('=');
          if (eq < 0) return a.trim();
          const col = a.slice(0, eq).trim();
          const val = a.slice(eq + 1).trim();
          return `${col} = IF(${cond}, ${val}, ${col})`;
        })
        .join(', ');
      sql = `${head}ON DUPLICATE KEY UPDATE ${wrapped}`;
    }
  }

  // SQLite ketargumentumu MAX/MIN -> MySQL GREATEST/LEAST (az egyargumentumu aggregalas marad)
  sql = sql.replace(/\bMAX\s*\(([^()]*,[^()]*)\)/gi, (m, a) => `GREATEST(${a})`);
  sql = sql.replace(/\bMIN\s*\(([^()]*,[^()]*)\)/gi, (m, a) => `LEAST(${a})`);

  // foglalt szo: a semaban egyedul a `key` oszlopnev utkozik (settings, partners, employees)
  sql = sql.replace(/(^|[\s(,.])key(?=[\s),=]|$)/gi, (m, pre) => {
    if (/primary\s*$/i.test(pre)) return m;      // PRIMARY KEY
    if (/foreign\s*$/i.test(pre)) return m;
    return `${pre}\`key\``;
  });
  sql = sql.replace(/PRIMARY\s+`key`/gi, 'PRIMARY KEY');
  sql = sql.replace(/DUPLICATE\s+`key`/gi, 'DUPLICATE KEY');

  return sql;
}


function globToRegex(pat) {
  let out = '^';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      let j = i + 1, cls = '[';
      if (pat[j] === '!') { cls += '^'; j++; }
      for (; j < pat.length && pat[j] !== ']'; j++) cls += pat[j];
      cls += ']';
      out += cls;
      i = j;
    } else if ('.^$+(){}|\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out + '$';
}

function quote(name) {
  return '`' + String(name).replace(/`/g, '') + '`';
}

class Stmt {
  constructor(pool, sql) {
    this.pool = pool;
    this.sql = translate(sql);
    this.args = [];
  }
  bind(...args) {
    const s = new Stmt(this.pool, '');
    s.sql = this.sql;
    s.args = args.map((a) => (a === undefined ? null : a));
    return s;
  }
  async all() {
    const [rows] = await this.pool.query(this.sql, this.args);
    return { results: Array.isArray(rows) ? rows : [], success: true, meta: {} };
  }
  async first(col) {
    const [rows] = await this.pool.query(this.sql, this.args);
    const r = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!r) return null;
    return col === undefined ? r : r[col];
  }
  async run() {
    const [res] = await this.pool.query(this.sql, this.args);
    return {
      success: true,
      meta: {
        changes: res?.affectedRows ?? 0,
        last_row_id: res?.insertId ?? 0,
        rows_written: res?.affectedRows ?? 0,
        rows_read: 0,
      },
    };
  }
  async raw() {
    const [rows] = await this.pool.query(this.sql, this.args);
    return (rows || []).map((r) => Object.values(r));
  }
}

export class MysqlD1 {
  constructor(pool) {
    this.pool = pool;
  }
  prepare(sql) {
    return new Stmt(this.pool, sql);
  }
  async batch(stmts) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = [];
      for (const s of stmts) {
        const [res] = await conn.query(s.sql, s.args);
        out.push(
          Array.isArray(res)
            ? { results: res, success: true, meta: {} }
            : { success: true, meta: { changes: res?.affectedRows ?? 0, last_row_id: res?.insertId ?? 0 } },
        );
      }
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
  async exec(sql) {
    await this.pool.query(translate(sql));
    return { count: 1, duration: 0 };
  }
}

export function createDb(cfg) {
  const pool = mysql.createPool({
    host: cfg.host || '127.0.0.1',
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit || 5,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  pool.on('connection', (conn) => {
    // a promise-wrapper esemenye nyers kapcsolatot ad: callback-es hivas kell
    try {
      conn.query("SET SESSION sql_mode='PIPES_AS_CONCAT,NO_ENGINE_SUBSTITUTION'", () => {});
    } catch {}
  });
  return new MysqlD1(pool);
}
