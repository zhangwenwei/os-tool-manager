import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../server/routes.js';

const TOKEN = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:7788';

// 伪适配器。不触碰实际系统（9.2 节）
function fakeAdapter(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake',
    detect: async () => true,
    list: async () => [
      { id: 'pkg-a', name: 'pkg-a', current: '1.0.0', latest: '1.1.0', status: 'outdated', active: null, actions: ['update', 'uninstall'] },
    ],
    actions: {
      update: { label: '更新', destructive: false, run: async () => ({ ok: true, exitCode: 0, stdout: 'updated', stderr: '', truncated: false }) },
      uninstall: { label: '卸载', destructive: true, run: async () => ({ ok: true, exitCode: 0, stdout: 'removed', stderr: '', truncated: false }) },
    },
    ...overrides,
  };
}

// 最小的 res 替身
function fakeRes() {
  return {
    statusCode: null, headers: null, body: null, headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
}

function fakeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = {
    method,
    headers: { 'x-token': TOKEN, ...headers },
    on(event, cb) {
      if (event === 'data' && body !== null) cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

async function call(router, pathname, reqOptions) {
  const res = fakeRes();
  await router(fakeReq(reqOptions), res, pathname);
  return res;
}

test('GET /api/adapters 返回可用生态', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.adapters, [
    { id: 'fake', label: 'Fake', actions: { update: { label: '更新', destructive: false }, uninstall: { label: '卸载', destructive: true } } },
  ]);
});

test('探测返回 false 的生态被排除（FR-02）', async () => {
  const router = createRouter({ adapters: [fakeAdapter({ detect: async () => false })], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters');
  assert.deepEqual(res.body.adapters, []);
});

test('探测抛出异常的生态被排除且不影响其他（FR-03）', async () => {
  const bad = fakeAdapter({ id: 'bad', detect: async () => { throw new Error('boom'); } });
  const good = fakeAdapter({ id: 'good' });
  const router = createRouter({ adapters: [bad, good], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.adapters.map(a => a.id), ['good']);
});

test('令牌无效时以 401 拒绝（SEC-06）', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters', { headers: { 'x-token': 'b'.repeat(64) } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'INVALID_TOKEN');
});

test('未知端点返回 404', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/nope');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});
