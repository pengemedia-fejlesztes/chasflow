import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Verziószám: v1.<commitok száma> – minden élesített változtatással nő.
const git = (cmd: string, fallback: string) => {
  try {
    return (
      execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || fallback
    );
  } catch {
    return fallback;
  }
};
const commits = git('git rev-list --count HEAD', '0');
const sha = git('git rev-parse --short HEAD', 'dev');
const buildDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest', dateStyle: 'short', timeStyle: 'short' }).format(new Date());

// A Mac-ügynök (mac-agent/) fájljai a felület mellől tölthetők le: /mac/… (pl. pmdev.hu/Cashflow/mac/aggreg8-install.sh).
// Build: bemásolja a dist/client/mac/ mappába; fejlesztéskor a Vite szerver szolgálja ki.
const MAC_DIR = resolve('mac-agent');
const macAgent = (): Plugin => ({
  name: 'mac-agent',
  configureServer(server) {
    server.middlewares.use('/mac/', (req, res, next) => {
      const file = resolve(MAC_DIR, decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, ''));
      if (!file.startsWith(MAC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(readFileSync(file));
    });
  },
  writeBundle(options) {
    if (options.dir) cpSync(MAC_DIR, join(options.dir, 'mac'), { recursive: true });
  },
});

export default defineConfig({
  root: 'src/client',
  publicDir: resolve('public'),
  plugins: [react(), macAgent()],
  define: {
    __APP_VERSION__: JSON.stringify(`v1.${commits}`),
    __APP_COMMIT__: JSON.stringify(sha),
    __APP_BUILD__: JSON.stringify(buildDate),
  },
  build: { outDir: resolve('dist/client'), emptyOutDir: true, sourcemap: false },
  // changeOrigin: false – a szerver a bongeszo eredeti Host-jat lassa, kulonben a CSRF Origin-ellenorzes
  // (src/server/app/index.ts) minden irast „Tiltott eredet” hibaval elutasitana.
  // A kulcs regex (^/api/), mert a sima '/api' elotag a felulet sajat /api.ts modulját is a szerverre kuldene.
  server: { proxy: { '^/api/': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  test: { root: '.', include: ['tests/**/*.test.{ts,tsx}'] },
} as any);
