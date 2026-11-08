// Bundle executable Mac helpers into the installer. Installed clients never fetch executable updates.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let installer = await readFile(`${root}/web/public/mac/aggreg8-install.sh`, 'utf8');
for (const [marker, file] of [
  ['DOWNLOAD', 'aggreg8-download.sh'],
  ['CDP', 'aggreg8-cdp.mjs'],
  ['EXPORT', 'aggreg8-export.js'],
]) {
  const content = await readFile(`${root}/web/public/mac/${file}`);
  installer = installer.replace(`__CF_MAC_${marker}_B64__`, content.toString('base64'));
}
await writeFile(`${root}/dist/mac/aggreg8-install.sh`, installer);
