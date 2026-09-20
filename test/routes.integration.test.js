import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRouter } from '../server/routes.js';

const TOKEN = 'a'.repeat(64);

function fakeAdapter() {
  return {
    id: 'fake',
    label: 'Fake',
    detect: async () => true,
    list: async () => [
      { id: 'pkg-a', name: 'pkg-a', current: '1.0.0', latest: '1.1.0', status: 'outdated', active: null, actions: ['update'] },
    ],
    actions: {
      update: {
        label: '更新',
        destructive: false,
        run: async () => ({ ok: true, exitCode: 0, signal: null, stdout: 'ok', stderr: '', truncated: false }),
      },
    },
  };
}

async function withServer(fn) {
  let router;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      await router(req, res, pathname);
    } catch (e) {
      if (res.headersSent) return;
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: e.message, detail: null } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin });
  try {
    await fn(origin);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const postHeaders = (origin) => ({ 'x-token': TOKEN, 'content-type': 'application/json', origin });

async function prime(origin) {
  await fetch(`${origin}/api/adapters/fake/items`, { headers: { 'x-token': TOKEN } });
}

test('经真实 HTTP 取得条目清单', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/adapters/fake/items`, { headers: { 'x-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.items[0].id, 'pkg-a');
  });
});

test('经真实 HTTP 执行操作', async () => {
  await withServer(async (origin) => {
    await prime(origin);
    const res = await fetch(`${origin}/api/adapters/fake/actions/update`, {
      method: 'POST',
      headers: postHeaders(origin),
      body: JSON.stringify({ itemId: 'pkg-a' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stdout, 'ok');
  });
});

test('请求体超过上限时返回 413 且不读完整个请求体', async () => {
  await withServer(async (origin) => {
    await prime(origin);
    const res = await fetch(`${origin}/api/adapters/fake/actions/update`, {
      method: 'POST',
      headers: postHeaders(origin),
      body: Buffer.alloc(1024 * 1024, 'x'),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('请求体非法 JSON 时返回 400', async () => {
  await withServer(async (origin) => {
    await prime(origin);
    const res = await fetch(`${origin}/api/adapters/fake/actions/update`, {
      method: 'POST',
      headers: postHeaders(origin),
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_BODY');
  });
});

test('请求体为空时视为空对象', async () => {
  await withServer(async (origin) => {
    await prime(origin);
    const res = await fetch(`${origin}/api/adapters/fake/actions/update`, {
      method: 'POST',
      headers: postHeaders(origin),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'STALE_ITEM');
  });
});

test('路径含非法百分号编码时返回 404 而非 500', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/adapters/%ZZ/items`, { headers: { 'x-token': TOKEN } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'UNKNOWN_ADAPTER');
  });
});

test('令牌缺失时返回 401', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/adapters`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'INVALID_TOKEN');
  });
});
