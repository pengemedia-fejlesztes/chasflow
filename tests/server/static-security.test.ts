import { mkdtemp, mkdir, symlink, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insideDirectory, staticPath } from '../../src/server/runtime/security.mjs';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
describe('statikus fájlok határa', () => {
  it('a szerveroldali csomag (dist/server) és a kódolt ../ nem része a statikus gyökérnek (dist/client)', async () => {
    expect(insideDirectory('/app/dist/client', '/app/dist/server/worker.mjs')).toBe(false);
    expect(await staticPath('/app/dist/client', '/%2e%2e%2fserver/worker.mjs')).toBeNull();
    expect(await staticPath('/app/dist/client', '/%00')).toBeNull();
    expect(await staticPath('/app/dist/client', '/%not-encoded')).toBeNull();
  });
  it('a symlink sem mutathat a statikus gyökéren kívülre', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-static-test-'));
    dirs.push(dir);
    const root = join(dir, 'dist');
    await mkdir(root);
    await writeFile(join(dir, 'private'), 'SYNTHETIC_SECRET');
    await symlink(join(dir, 'private'), join(root, 'link'));
    expect(await staticPath(root, '/link')).toBeNull();
    await writeFile(join(root, 'index.html'), 'app');
    expect(await staticPath(root, '/index.html')).toBe(await realpath(join(root, 'index.html')));
  });
});
