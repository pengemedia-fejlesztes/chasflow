import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
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

export default defineConfig({
  root: 'web',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(`v1.${commits}`),
    __APP_COMMIT__: JSON.stringify(sha),
    __APP_BUILD__: JSON.stringify(buildDate),
  },
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as any);
