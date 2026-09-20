import { checkToken, checkOrigin, checkAction, checkItemId, checkConfirm } from './security.js';

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

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (c) => {
      length += c.length;
      if (length > limit) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
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

    const actionMatch = pathname.match(/^\/api\/adapters\/([^/]+)\/actions\/([^/]+)$/);
    if (req.method === 'POST' && actionMatch) {
      const originErr = checkOrigin(req, origin);
      if (originErr) return fail(res, originErr.status, originErr.code, originErr.message);

      const adapter = byId(safeDecode(actionMatch[1]));
      if (!adapter) return fail(res, 404, 'UNKNOWN_ADAPTER', '未知的生态。');

      const actionKey = safeDecode(actionMatch[2]);
      const actionErr = checkAction(adapter, actionKey);
      if (actionErr) return fail(res, actionErr.status, actionErr.code, actionErr.message);
      const action = adapter.actions[actionKey];

      let body;
      try {
        body = await readBody(req);
      } catch {
        return fail(res, 400, 'BAD_BODY', '请求体无法解析。');
      }

      const items = known.get(adapter.id);
      const idErr = checkItemId(items, body.itemId);
      if (idErr) return fail(res, idErr.status, idErr.code, idErr.message);

      const confirmErr = checkConfirm(action, body);
      if (confirmErr) return fail(res, confirmErr.status, confirmErr.code, confirmErr.message);

      if (busy.has(adapter.id)) {
        return fail(res, 409, 'BUSY', '该生态已有操作正在执行，请稍候。');
      }

      busy.add(adapter.id);
      try {
        const result = await action.run(items.get(body.itemId));
        return send(res, 200, result);
      } catch (e) {
        if (e.code === 'TIMEOUT') return fail(res, 504, 'TIMEOUT', e.message, e.detail ?? null);
        return fail(res, 500, 'INTERNAL', '操作执行中发生错误。', e.detail ?? e.message);
      } finally {
        busy.delete(adapter.id);
      }
    }

    return fail(res, 404, 'NOT_FOUND', '未知的端点。');
  };
}

export { send };
