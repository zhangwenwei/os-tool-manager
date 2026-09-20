import { randomBytes, timingSafeEqual } from 'node:crypto';

const deny = (status, code, message) => ({ status, code, message });

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export function checkToken(req, expected) {
  const actual = req.headers['x-token'];
  if (typeof actual !== 'string' || actual.length !== expected.length) {
    return deny(401, 'INVALID_TOKEN', '访问令牌无效。');
  }
  const ok = timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  return ok ? null : deny(401, 'INVALID_TOKEN', '访问令牌无效。');
}

export function checkOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin || origin !== allowedOrigin) {
    return deny(403, 'BAD_ORIGIN', '请求来源不被允许。');
  }
  return null;
}

export function checkAction(adapter, actionKey) {
  if (!adapter.actions || !Object.hasOwn(adapter.actions, actionKey)) {
    return deny(400, 'UNKNOWN_ACTION', `未知的操作：${actionKey}`);
  }
  return null;
}

export function checkItemId(knownItems, itemId) {
  if (!knownItems || !knownItems.has(itemId)) {
    return deny(409, 'STALE_ITEM', '该条目已不在最新的清单中，请先刷新。');
  }
  return null;
}

export function checkConfirm(action, body) {
  if (action.destructive && body.confirm !== true) {
    return deny(400, 'CONFIRM_REQUIRED', '该操作需要确认。');
  }
  return null;
}
