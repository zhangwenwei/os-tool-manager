import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const deny = (status, code, message) => ({ status, code, message });

const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export function checkToken(req, expected) {
  const actual = req.headers['x-token'];
  if (typeof actual !== 'string') {
    return deny(401, 'INVALID_TOKEN', '访问令牌无效。');
  }
  return timingSafeEqual(digest(actual), digest(expected))
    ? null
    : deny(401, 'INVALID_TOKEN', '访问令牌无效。');
}

export function checkOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin || origin !== allowedOrigin) {
    return deny(403, 'BAD_ORIGIN', '请求来源不被允许。');
  }
  return null;
}

export function checkAction(adapter, actionKey) {
  if (!adapter?.actions || !Object.hasOwn(adapter.actions, actionKey)) {
    return deny(400, 'UNKNOWN_ACTION', '未知的操作。');
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
  if (!action) {
    return deny(400, 'UNKNOWN_ACTION', '未知的操作。');
  }
  if (action.destructive && body?.confirm !== true) {
    return deny(400, 'CONFIRM_REQUIRED', '该操作需要确认。');
  }
  return null;
}
