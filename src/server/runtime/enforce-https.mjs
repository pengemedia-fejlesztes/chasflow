import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const BEGIN = '# BEGIN CASHFLOW HTTPS';
const END = '# END CASHFLOW HTTPS';
export function httpsConfig(previous) {
  const block = `${BEGIN}\nRewriteEngine On\nRewriteCond %{REQUEST_URI} ^/Cashflow(?:/|$)\nRewriteCond %{HTTPS} !=on\nRewriteRule ^ https://pmdev.hu%{REQUEST_URI} [R=308,L,NE]\n${END}\n`;
  const old = previous.replace(/# BEGIN CASHFLOW HTTPS\n[\s\S]*?# END CASHFLOW HTTPS\n?/g, '');
  return block + old;
}

// Public webroot and Passenger app root differ: install at the TLS terminator as well.
// The workflow first runs a dry run, then creates the backup before writing.
async function main() {
  const [target, backup, apply] = process.argv.slice(2);
  if (!target || !backup) throw new Error('Usage: enforce-https.mjs target backup [--apply]');
  if (!(await stat(dirname(target))).isDirectory()) throw new Error('Public Cashflow webroot not found; configure HTTPS at the TLS terminator.');
  let previous = '';
  try {
    previous = await readFile(target, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const next = httpsConfig(previous);
  console.log(JSON.stringify({ target, changed: previous !== next, apply: apply === '--apply' }));
  if (apply !== '--apply' || previous === next) return;
  await writeFile(backup, previous, { flag: 'wx', mode: 0o600 });
  await writeFile(target, next);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
