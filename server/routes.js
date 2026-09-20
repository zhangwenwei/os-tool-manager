import { checkToken, checkOrigin, checkAction, checkItemId, checkConfirm } from './security.js';

class BodyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
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
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      length += c.length;
      if (length > limit) {
        aborted = true;
        req.pause();
        reject(new BodyError('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new BodyError('BAD_BODY'));
      }
    });
    req.on('error', reject);
  });
}

export function createRouter({ adapters, token, origin }) {
  const listedItems = new Map();
  const busy = new Set();

  const byId = (id) => adapters.find((a) => a.id === id) ?? null;

  return async function handleApi(req, res, pathname) {
    const tokenErr = checkToken(req, token);
    if (tokenErr) return fail(res, tokenErr.status, tokenErr.code, tokenErr.message);

    if (req.method === 'GET' && pathname === '/api/adapters') {
      const results = await Promise.all(
        adapters.map(async (a) => {
          let available;
          try {
            available = await a.detect();
          } catch {
            return null;
          }
          return available ? { id: a.id, label: a.label, actions: publicActions(a) } : null;
        })
      );
      return send(res, 200, { adapters: results.filter(Boolean) });
    }

    const itemsMatch = pathname.match(/^\/api\/adapters\/([^/]+)\/items$/);
    if (req.method === 'GET' && itemsMatch) {
      const adapter = byId(safeDecode(itemsMatch[1]));
      if (!adapter) return fail(res, 404, 'UNKNOWN_ADAPTER', '未知的生态。');
      let items;
      try {
        items = await adapter.list();
      } catch (e) {
        if (e.code === 'TIMEOUT') return fail(res, 504, 'TIMEOUT', '命令执行超时。', e.message);
        return fail(res, 500, 'INTERNAL', '条目清单取得失败。', e.detail ?? e.message);
      }
      listedItems.set(adapter.id, new Map(items.map((i) => [i.id, i])));
      return send(res, 200, { items });
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
      } catch (e) {
        if (e.code === 'PAYLOAD_TOO_LARGE') return fail(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大。');
        return fail(res, 400, 'BAD_BODY', '请求体无法解析。');
      }

      const items = listedItems.get(adapter.id);
      const idErr = checkItemId(items, body.itemId);
      if (idErr) return fail(res, idErr.status, idErr.code, idErr.message);

      const confirmErr = checkConfirm(action, body);
      if (confirmErr) return fail(res, confirmErr.status, confirmErr.code, confirmErr.message);

      if (busy.has(adapter.id)) {
        return fail(res, 409, 'BUSY', '该生态已有操作正在执行，请稍候。');
      }

      busy.add(adapter.id);
      let result;
      try {
        result = await action.run(items.get(body.itemId));
      } catch (e) {
        if (e.code === 'TIMEOUT') return fail(res, 504, 'TIMEOUT', '命令执行超时。', e.message);
        return fail(res, 500, 'INTERNAL', '操作执行中发生错误。', e.detail ?? e.message);
      } finally {
        busy.delete(adapter.id);
      }
      return send(res, 200, result);
    }

    return fail(res, 404, 'NOT_FOUND', '未知的端点。');
  };
}
