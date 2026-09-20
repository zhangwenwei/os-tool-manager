import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler, handleServerError } from '../server/app.js';

const BASE = 'http://127.0.0.1:7788';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
}

test('/api/ 开头的路径交给 API 处理器', async () => {
  let seen = null;
  const handle = createRequestHandler({
    handleApi: async (req, res, pathname) => { seen = pathname; },
    handleStatic: async () => { throw new Error('不应走到静态处理'); },
    baseUrl: BASE,
  });
  await handle({ url: '/api/adapters' }, fakeRes());
  assert.equal(seen, '/api/adapters');
});

test('其余路径交给静态处理器', async () => {
  let seen = null;
  const handle = createRequestHandler({
    handleApi: async () => { throw new Error('不应走到 API 处理'); },
    handleStatic: async (req, res, pathname) => { seen = pathname; },
    baseUrl: BASE,
  });
  await handle({ url: '/style.css' }, fakeRes());
  assert.equal(seen, '/style.css');
});

test('查询参数不参与路径判定', async () => {
  let seen = null;
  const handle = createRequestHandler({
    handleApi: async () => {},
    handleStatic: async (req, res, pathname) => { seen = pathname; },
    baseUrl: BASE,
  });
  await handle({ url: '/?token=abc' }, fakeRes());
  assert.equal(seen, '/');
});

test('处理器抛出时返回 500 且不中断进程（NFR-13）', async () => {
  const handle = createRequestHandler({
    handleApi: async () => { throw new Error('炸了'); },
    handleStatic: async () => {},
    baseUrl: BASE,
  });
  const res = fakeRes();
  await handle({ url: '/api/adapters' }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL');
  assert.equal(res.body.error.detail, '炸了');
});

test('响应头已发出时不再二次写入', async () => {
  const handle = createRequestHandler({
    handleApi: async (req, res) => {
      res.writeHead(200);
      throw new Error('写头之后才抛出');
    },
    handleStatic: async () => {},
    baseUrl: BASE,
  });
  const res = fakeRes();
  await handle({ url: '/api/adapters' }, res);
  assert.equal(res.statusCode, 200);
});

test('端口占用时打印变更方法并以 1 退出（NFR-14）', () => {
  const logged = [];
  let exitCode = null;
  const err = new Error('listen EADDRINUSE');
  err.code = 'EADDRINUSE';
  handleServerError(err, 7788, { error: (m) => logged.push(String(m)), exit: (c) => { exitCode = c; } });
  assert.equal(exitCode, 1);
  assert.ok(logged.some((m) => m.includes('7788') && m.includes('已被占用')));
  assert.ok(logged.some((m) => m.includes('PORT=')));
});

test('其他启动错误原样打印并以 1 退出', () => {
  const logged = [];
  let exitCode = null;
  handleServerError(new Error('别的错'), 7788, { error: (m) => logged.push(m), exit: (c) => { exitCode = c; } });
  assert.equal(exitCode, 1);
  assert.equal(logged.length, 1);
});

test('以 api 开头但非 /api/ 的路径走静态处理', async () => {
  let seen = null;
  const handle = createRequestHandler({
    handleApi: async () => { throw new Error('不应走到 API 处理'); },
    handleStatic: async (req, res, pathname) => { seen = pathname; },
    baseUrl: 'http://127.0.0.1:7788',
  });
  await handle({ url: '/apixyz.js' }, { writeHead() {}, end() {}, headersSent: false });
  assert.equal(seen, '/apixyz.js');
});
