import { checkToken } from './security.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function fail(res, status, code, message, detail = null) {
  send(res, status, { error: { code, message, detail } });
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function publicActions(adapter) {
  const out = {};
  for (const [key, action] of Object.entries(adapter.actions)) {
    out[key] = { label: action.label, destructive: action.destructive };
  }
  return out;
}

export function createRouter({ adapters, token, origin }) {
  const known = new Map();   // adapterId -> Map<itemId, Item>（SEC-09）
  const busy = new Set();    // adapterId（FR-19）

  const byId = (id) => adapters.find((a) => a.id === id) ?? null;

  return async function handleApi(req, res, pathname) {
    const tokenErr = checkToken(req, token);
    if (tokenErr) return fail(res, tokenErr.status, tokenErr.code, tokenErr.message);

    if (req.method === 'GET' && pathname === '/api/adapters') {
      const results = await Promise.all(
        adapters.map(async (a) => {
          try {
            return (await a.detect())
              ? { id: a.id, label: a.label, actions: publicActions(a) }
              : null;
          } catch {
            return null;
          }
        })
      );
      return send(res, 200, { adapters: results.filter(Boolean) });
    }

    const itemsMatch = pathname.match(/^\/api\/adapters\/([^/]+)\/items$/);
    if (req.method === 'GET' && itemsMatch) {
      const adapter = byId(safeDecode(itemsMatch[1]));
      if (!adapter) return fail(res, 404, 'UNKNOWN_ADAPTER', '未知的生态。');
      try {
        const items = await adapter.list();
        known.set(adapter.id, new Map(items.map((i) => [i.id, i])));
        return send(res, 200, { items });
      } catch (e) {
        if (e.code === 'TIMEOUT') return fail(res, 504, 'TIMEOUT', e.message, e.detail ?? null);
        return fail(res, 500, 'INTERNAL', '条目清单取得失败。', e.detail ?? e.message);
      }
    }

    return fail(res, 404, 'NOT_FOUND', '未知的端点。');
  };
}

export { send };
