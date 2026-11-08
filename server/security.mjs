import { isAbsolute, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

export function insideDirectory(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
}

/** Decode once, reject sibling-prefix traversal and symlinks escaping the static root. */
export async function staticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const file = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (!insideDirectory(root, file)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    return insideDirectory(realRoot, realFile) ? realFile : null;
  } catch {
    return file; // missing assets retain the existing SPA fallback
  }
}
