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
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.adapters, [
    { id: 'fake', label: 'Fake', actions: { update: { label: '更新', destructive: false }, uninstall: { label: '卸载', destructive: true } } },
  ]);
});

test('探测返回 false 的生态被排除（FR-02）', async () => {
  const router = createRouter({ adapters: [fakeAdapter({ detect: async () => false })], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters');
  assert.deepEqual(res.body.adapters, []);
});

test('探测抛出异常的生态被排除且不影响其他（FR-03）', async () => {
  const bad = fakeAdapter({ id: 'bad', detect: async () => { throw new Error('boom'); } });
  const good = fakeAdapter({ id: 'good' });
  const router = createRouter({ adapters: [bad, good], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.adapters.map(a => a.id), ['good']);
});

test('令牌无效时以 401 拒绝（SEC-06）', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters', { headers: { 'x-token': 'b'.repeat(64) } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'INVALID_TOKEN');
});

test('未知端点返回 404', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/nope');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('GET items 返回条目清单', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, 'pkg-a');
});

test('GET items 未知生态返回 404', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/nope/items');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'UNKNOWN_ADAPTER');
});

test('GET items 超时时返回 504', async () => {
  const err = new Error('timeout'); err.code = 'TIMEOUT';
  const adapter = fakeAdapter({ list: async () => { throw err; } });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.error.code, 'TIMEOUT');
});

test('GET items 其他异常时返回 500', async () => {
  const adapter = fakeAdapter({ list: async () => { throw new Error('boom'); } });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL');
});

const POST = (body) => ({ method: 'POST', headers: { origin: ORIGIN }, body });

// 操作前必须先取得清单，否则 SEC-09 会拒绝
async function primed(adapter) {
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  await call(router, '/api/adapters/fake/items');
  return router;
}

test('POST action 正常执行并返回 ActionResult', async () => {
  const router = await primed(fakeAdapter());
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stdout, 'updated');
});

test('POST action 破坏性操作带确认时执行（SEC-10）', async () => {
  const router = await primed(fakeAdapter());
  const res = await call(router, '/api/adapters/fake/actions/uninstall', POST({ itemId: 'pkg-a', confirm: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test('POST action 破坏性操作缺确认时以 400 拒绝（SEC-10）', async () => {
  const router = await primed(fakeAdapter());
  const res = await call(router, '/api/adapters/fake/actions/uninstall', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'CONFIRM_REQUIRED');
});

test('POST action Origin 缺失时以 403 拒绝（SEC-07）', async () => {
  const router = await primed(fakeAdapter());
  const res = await call(router, '/api/adapters/fake/actions/update', { method: 'POST', body: { itemId: 'pkg-a' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'BAD_ORIGIN');
});

test('POST action 未声明的操作以 400 拒绝（SEC-08）', async () => {
  const router = await primed(fakeAdapter());
  const res = await call(router, '/api/adapters/fake/actions/evil', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'UNKNOWN_ACTION');
});

test('POST action 未知条目 ID 以 409 拒绝（SEC-09）', async () => {
  const router = await primed(fakeAdapter());
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'not-listed' }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'STALE_ITEM');
});

test('POST action 清单未取得时以 409 拒绝（SEC-09）', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'STALE_ITEM');
});

test('POST action 同一生态并发时以 409 BUSY 拒绝（FR-19）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const adapter = fakeAdapter();
  adapter.actions.update.run = async () => {
    await gate;
    return { ok: true, exitCode: 0, stdout: '', stderr: '', truncated: false };
  };
  const router = await primed(adapter);

  const first = call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  await new Promise((r) => setImmediate(r));
  const second = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));

  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error.code, 'BUSY');

  release();
  const firstRes = await first;
  assert.equal(firstRes.statusCode, 200);
});

test('POST action 执行结束后解除排他（FR-19）', async () => {
  const router = await primed(fakeAdapter());
  await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 200);
});

test('POST action 失败时也解除排他（FR-19）', async () => {
  const adapter = fakeAdapter();
  adapter.actions.update.run = async () => { throw new Error('boom'); };
  const router = await primed(adapter);
  const first = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(first.statusCode, 500);
  assert.equal(first.body.error.code, 'INTERNAL');
  const second = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(second.statusCode, 500);
  assert.equal(second.body.error.code, 'INTERNAL');
});

test('POST action 超时时返回 504（NFR-08）', async () => {
  const err = new Error('命令超时（600000ms）：fake');
  err.code = 'TIMEOUT';
  const adapter = fakeAdapter();
  adapter.actions.update.run = async () => { throw err; };
  const router = await primed(adapter);
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.error.code, 'TIMEOUT');
  assert.equal(res.body.error.detail, '命令超时（600000ms）：fake');
});

test('POST action 失败时 detail 含命令输出（FR-21）', async () => {
  const err = new Error('boom');
  err.detail = '假命令失败\nstderr 的内容';
  const adapter = fakeAdapter();
  adapter.actions.update.run = async () => { throw err; };
  const router = await primed(adapter);
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.detail, '假命令失败\nstderr 的内容');
});

test('POST action 传给 run 的是条目对象而非 ID', async () => {
  let received;
  const adapter = fakeAdapter();
  adapter.actions.update.run = async (item) => {
    received = item;
    return { ok: true, exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false };
  };
  const router = await primed(adapter);
  await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(received.name, 'pkg-a');
  assert.equal(received.current, '1.0.0');
});

test('响应带 no-store 缓存头', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('适配器声明缺失时抛出且指名是哪个适配器', async () => {
  const broken = { id: 'broken', label: 'Broken', detect: async () => true };
  const router = createRouter({ adapters: [broken], token: TOKEN, allowedOrigins: [ORIGIN] });
  await assert.rejects(() => call(router, '/api/adapters'), (e) => e.message.includes('broken'));
});

test('操作声明不完整时抛出且指名是哪个操作', async () => {
  const broken = {
    id: 'half', label: 'Half', detect: async () => true,
    actions: { update: { label: '更新' } },
  };
  const router = createRouter({ adapters: [broken], token: TOKEN, allowedOrigins: [ORIGIN] });
  await assert.rejects(
    () => call(router, '/api/adapters'),
    (e) => e.message.includes('half') && e.message.includes('update')
  );
});

test('适配器的下游失败返回 502 而非 500', async () => {
  const { AdapterError } = await import('../server/adapters/base.js');
  const adapter = fakeAdapter({
    list: async () => { throw new AdapterError('LIST_FAILED', 'brew 连不上网'); },
  });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error.code, 'ADAPTER_FAILED');
  assert.equal(res.body.error.detail, 'brew 连不上网');
});

test('命令不存在返回 502 并提示 PATH', async () => {
  // exec.js 对全部 spawn 失败一律包成 ExecError，此处构造与生产一致的形态
  const { ExecError } = await import('../server/exec.js');
  const adapter = fakeAdapter({
    list: async () => { throw new ExecError('ENOENT', '命令执行失败：brew'); },
  });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error.message, /PATH/);
});

test('适配器自身的缺陷仍返回 500', async () => {
  const { AdapterError } = await import('../server/adapters/base.js');
  const adapter = fakeAdapter({
    list: async () => { throw new AdapterError('BAD_ITEM_ID', '条目 ID 无法解析'); },
  });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL');
});

test('未知的异常仍返回 500', async () => {
  const adapter = fakeAdapter({ list: async () => { throw new Error('boom'); } });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL');
});

test('资源耗尽类的 spawn 失败也归为 502', async () => {
  const { ExecError } = await import('../server/exec.js');
  const adapter = fakeAdapter({
    list: async () => { throw new ExecError('EMFILE', '文件句柄耗尽'); },
  });
  const router = createRouter({ adapters: [adapter], token: TOKEN, allowedOrigins: [ORIGIN] });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error.code, 'ADAPTER_FAILED');
});

test('操作缺少 destructive 时抛出', async () => {
  const broken = {
    id: 'nodest', label: 'X', detect: async () => true,
    actions: { update: { label: '更新', run: async () => ({}) } },
  };
  const router = createRouter({ adapters: [broken], token: TOKEN, allowedOrigins: [ORIGIN] });
  await assert.rejects(() => call(router, '/api/adapters'), (e) => e.message.includes('nodest'));
});

test('操作缺少 run 时抛出', async () => {
  const broken = {
    id: 'norun', label: 'X', detect: async () => true,
    actions: { update: { label: '更新', destructive: false } },
  };
  const router = createRouter({ adapters: [broken], token: TOKEN, allowedOrigins: [ORIGIN] });
  await assert.rejects(() => call(router, '/api/adapters'), (e) => e.message.includes('norun'));
});
