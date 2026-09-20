import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function resolveStaticPath(pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  } catch {
    return null;
  }
  if (rel.includes('/') || rel.includes('\\') || rel.includes('..')) return null;
  const dot = rel.lastIndexOf('.');
  if (dot === -1) return null;
  return Object.hasOwn(TYPES, rel.slice(dot)) ? rel : null;
}

export function createStatic(rootDir) {
  return async function handleStatic(req, res, pathname) {
    const rel = resolveStaticPath(pathname);
    if (!rel) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      const buf = await readFile(join(rootDir, rel));
      res.writeHead(200, { 'content-type': TYPES[rel.slice(rel.lastIndexOf('.'))] });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  };
}
