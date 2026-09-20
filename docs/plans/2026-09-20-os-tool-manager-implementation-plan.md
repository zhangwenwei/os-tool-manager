# os-tool-manager 实装计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个仅监听 `127.0.0.1` 的本地 Web 面板，用于查看与管理 Homebrew 包、npm 全局包、pip 用户级包（清单、版本、更新、卸载）。

**Architecture:** 适配器模式。`server/adapters/*` 各自封装一个生态的全部知识并实现统一接口（`detect` / `list` / `actions`）；`routes.js` 与 `web/app.js` 只依赖该统一接口，不含任何具体生态名称。安全边界由 `security.js` 集中实现：仅绑定回环地址、`/api/*` 强制令牌、POST 强制 `Origin` 校验、操作种类与操作对象双白名单、子进程参数以数组传递。

**Tech Stack:** Node.js 20+（本机 v25.9.0）、ESM、零运行时依赖、`node:http`、`node:test`、原生 HTML/CSS/JS。

**要件定义书:** `docs/specs/2026-09-20-os-tool-manager-requirements.md` v3.0

---

## 契约补充

实装推导出的两处契约细节。不改变既有要件，仅将要件书未精确定义的响应结构固定下来。

**补充 1：`GET /api/adapters` 的响应结构**

要件书 7.5 节仅记「本机可用的生态清单」。FR-13（依 `actions` 动态渲染按钮）与 FR-15（破坏性操作需确认）要求前端知道每个操作的显示名与 `destructive` 标志，故响应中须包含操作元数据：

```js
{
  adapters: [
    {
      id: 'homebrew',
      label: 'Homebrew',
      actions: {
        update:    { label: '更新', destructive: false },
        uninstall: { label: '卸载', destructive: true }
      }
    }
  ]
}
```

**补充 2：Homebrew 的条目 ID 编码**

formula 与 cask 的包名可能重复，而 Item.id 须在生态内唯一（7.2 节）。故 id 采用 `formula:<name>` / `cask:<name>` 形式，`name` 字段仍为纯包名。`run()` 依 id 前缀决定命令参数。

---

## 文件构成

| 文件 | 职责 | 关联要件 |
|---|---|---|
| `package.json` | 启动与测试脚本 | NFR-04 |
| `.env.example` | 配置项样例 | NFR-05 |
| `server/config.js` | `.env` 读取与默认值适用 | NFR-05、NFR-06 |
| `server/exec.js` | 子进程执行：超时、截断、数组参数 | NFR-07～09、SEC-11 |
| `server/security.js` | 令牌、`Origin`、双白名单、确认标记 | SEC-02、04、06～10 |
| `server/routes.js` | API 路由、排他控制、错误响应 | FR-01～03、19、7.6 节 |
| `server/static.js` | 静态资源提供 | SEC-05 |
| `server/index.js` | 启动、令牌生成、URL 打印、端口占用 | SEC-01、03、NFR-13、14 |
| `server/adapters/registry.js` | 适配器注册表 | NFR-11 |
| `server/adapters/homebrew.js` | SC-01 | NFR-12 |
| `server/adapters/npm.js` | SC-02 | NFR-12 |
| `server/adapters/pip.js` | SC-03 | NFR-12 |
| `web/index.html` | 页面骨架 | — |
| `web/style.css` | 样式 | — |
| `web/app.js` | 渲染、令牌保持、确认提示 | FR-04～21、SEC-13 |
| `test/*.test.js` | 自动测试 | 9.2 节 |

依赖方向：`index.js` → `routes.js` → `adapters/*` → `exec.js`。`security.js` 与 `config.js` 为无依赖的叶子模块。

---

## Task 1: 项目骨架与配置模块

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `server/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "os-tool-manager",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test 'test/**/*.js'"
  }
}
```

> 测试脚本使用 glob 而非 `node --test test/`：本机 Node v25.9.0 会把目录参数当作 CJS 入口模块去 require，报 `Cannot find module '.../test'`。单文件形式（`node --test test/xxx.test.js`）正常。

- [ ] **Step 2: 写失败的测试**

创建 `test/config.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, buildConfig, DEFAULTS } from '../server/config.js';

test('parseEnv 忽略空行与注释', () => {
  const text = '# comment\n\nPORT=9000\n  LIST_TIMEOUT_MS = 1000  \n';
  assert.deepEqual(parseEnv(text), { PORT: '9000', LIST_TIMEOUT_MS: '1000' });
});

test('parseEnv 保留值中的等号', () => {
  assert.deepEqual(parseEnv('A=b=c'), { A: 'b=c' });
});

test('buildConfig 无输入时全部采用默认值', () => {
  assert.deepEqual(buildConfig(), DEFAULTS);
});

test('buildConfig 部分定义时仅覆盖该项', () => {
  const cfg = buildConfig({ PORT: '9000' });
  assert.equal(cfg.PORT, 9000);
  assert.equal(cfg.LIST_TIMEOUT_MS, DEFAULTS.LIST_TIMEOUT_MS);
});

test('buildConfig 数值项非数值时退回默认值', () => {
  assert.equal(buildConfig({ PORT: 'abc' }).PORT, DEFAULTS.PORT);
});

test('buildConfig 空字符串视为未定义', () => {
  assert.equal(buildConfig({ PORT: '' }).PORT, DEFAULTS.PORT);
});

test('buildConfig 布尔项仅 "true" 为真', () => {
  assert.equal(buildConfig({ AUTO_OPEN_BROWSER: 'false' }).AUTO_OPEN_BROWSER, false);
  assert.equal(buildConfig({ AUTO_OPEN_BROWSER: 'true' }).AUTO_OPEN_BROWSER, true);
});

test('buildConfig 忽略未知键', () => {
  assert.equal(buildConfig({ UNKNOWN: 'x' }).UNKNOWN, undefined);
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm test
```

Expected: FAIL，`Cannot find module '.../server/config.js'`

> **实装后的修订（代码评审对应）**：本节代码为初版。实际实装在评审后追加了数值项的整数与取值域校验、布尔项的严格解析、`.env` 值的引号剥离、无效值警告、`loadConfig` 的 ENOENT 与其他错误的区分，以及记忆化的 `getConfig()`。最终形态见 `server/config.js`（commit `fae0790`）。后续任务一律使用 `getConfig()` 取配置，不再各自 `loadConfig`。

- [ ] **Step 4: 实装 `server/config.js`**

```js
import { readFileSync } from 'node:fs';

export const DEFAULTS = {
  PORT: 7788,
  LIST_TIMEOUT_MS: 60000,
  ACTION_TIMEOUT_MS: 600000,
  MAX_OUTPUT_BYTES: 1048576,
  AUTO_OPEN_BROWSER: true,
};

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function buildConfig(raw = {}) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined || value === '') continue;
    if (typeof DEFAULTS[key] === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) config[key] = n;
    } else {
      config[key] = value === 'true';
    }
  }
  return config;
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return buildConfig();
  }
  return buildConfig(parseEnv(text));
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm test
```

Expected: PASS，8 tests

- [ ] **Step 6: 创建 `.env.example`**

```
# os-tool-manager 配置。复制为 .env 后修改。
# 全部项目可省略，省略时采用括号内的默认值。

# HTTP 服务端口（7788）
PORT=7788

# 条目清单取得的子进程超时，毫秒（60000）
LIST_TIMEOUT_MS=60000

# 操作执行的子进程超时，毫秒（600000）
ACTION_TIMEOUT_MS=600000

# 子进程输出的保留上限，字节（1048576）
MAX_OUTPUT_BYTES=1048576

# 启动时是否自动打开浏览器（true）
AUTO_OPEN_BROWSER=true
```

- [ ] **Step 7: 提交**

```bash
git add package.json .env.example server/config.js test/config.test.js
git commit -m "feat: 项目骨架与配置模块（NFR-04～NFR-06）"
```

---

## Task 2: 子进程执行模块

**Files:**
- Create: `server/exec.js`
- Test: `test/exec.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `test/exec.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, truncate, ExecError } from '../server/exec.js';

const OPTS = { timeoutMs: 5000, maxBytes: 1048576 };

test('truncate 未超限时原样返回', () => {
  const r = truncate(Buffer.from('hello'), 100);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
});

test('truncate 超限时保留首尾并标示', () => {
  const r = truncate(Buffer.from('a'.repeat(50) + 'b'.repeat(50)), 20);
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith('aaaaaaaaaa'));
  assert.ok(r.text.endsWith('bbbbbbbbbb'));
  assert.ok(r.text.includes('已省略'));
});

test('run 正常结束时返回 ok 与 stdout', async () => {
  const r = await run('echo', ['hello'], OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), 'hello');
  assert.equal(r.truncated, false);
});

test('run 非零退出码时 ok 为 false 但不抛出', async () => {
  const r = await run('sh', ['-c', 'echo oops >&2; exit 3'], OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr.trim(), 'oops');
});

test('run 参数以数组传递，不经由 shell 展开（SEC-11）', async () => {
  const r = await run('echo', ['$HOME; rm -rf /tmp/nonexistent'], OPTS);
  assert.equal(r.stdout.trim(), '$HOME; rm -rf /tmp/nonexistent');
});

test('run 超时时抛出 TIMEOUT 并终止子进程', async () => {
  await assert.rejects(
    () => run('sleep', ['5'], { timeoutMs: 100, maxBytes: 1024 }),
    (e) => e instanceof ExecError && e.code === 'TIMEOUT'
  );
});

test('run 命令不存在时抛出 ENOENT', async () => {
  await assert.rejects(
    () => run('definitely-not-a-real-command-xyz', [], OPTS),
    (e) => e instanceof ExecError && e.code === 'ENOENT'
  );
});

test('run 输出超限时标示 truncated', async () => {
  const r = await run('sh', ['-c', 'printf "x%.0s" $(seq 1 500)'], { timeoutMs: 5000, maxBytes: 100 });
  assert.equal(r.truncated, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/exec.test.js
```

Expected: FAIL，`Cannot find module '.../server/exec.js'`

> **实装后的修订（代码评审 Critical 对应）**：本节代码为初版，存在超时机制失效的缺陷 —— 仅终止直接子进程时，孙进程继续持有管道导致 `close` 永不触发、Promise 永不 settle。最终形态见 `server/exec.js`（commit `8fc031d`）：子进程改为 `detached` 并终止整个进程组、追加宽限定时器、输出改为流式截断、`spawn` 错误透传真实 errno、校验 options、截断处对齐 UTF-8 边界、结果追加 `signal` 字段。测试由 8 件增至 20 件。

- [ ] **Step 3: 实装 `server/exec.js`**

```js
import { spawn } from 'node:child_process';

export class ExecError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.detail = detail;
  }
}

export function truncate(buf, maxBytes) {
  if (buf.length <= maxBytes) {
    return { text: buf.toString('utf8'), truncated: false };
  }
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.length - half).toString('utf8');
  const omitted = buf.length - half * 2;
  return {
    text: `${head}\n…（中间 ${omitted} 字节已省略）…\n${tail}`,
    truncated: true,
  };
}

export function run(command, args, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));

    child.on('error', (err) => {
      finish(reject, new ExecError('ENOENT', `命令执行失败：${command}`, err.message));
    });

    child.on('close', (exitCode) => {
      if (timedOut) {
        finish(reject, new ExecError('TIMEOUT', `命令超时（${timeoutMs}ms）：${command}`));
        return;
      }
      const out = truncate(Buffer.concat(outChunks), maxBytes);
      const err = truncate(Buffer.concat(errChunks), maxBytes);
      finish(resolve, {
        ok: exitCode === 0,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/exec.test.js
```

Expected: PASS，8 tests

- [ ] **Step 5: 提交**

```bash
git add server/exec.js test/exec.test.js
git commit -m "feat: 子进程执行模块（NFR-07～NFR-09、SEC-11）"
```

---

## Task 3: 安全校验模块

**Files:**
- Create: `server/security.js`
- Test: `test/security.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `test/security.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateToken, checkToken, checkOrigin,
  checkAction, checkItemId, checkConfirm,
} from '../server/security.js';

const req = (headers) => ({ headers });

test('generateToken 产生 64 字符的十六进制串', () => {
  const t = generateToken();
  assert.match(t, /^[0-9a-f]{64}$/);
});

test('generateToken 每次不同', () => {
  assert.notEqual(generateToken(), generateToken());
});

test('checkToken 一致时通过', () => {
  const t = generateToken();
  assert.equal(checkToken(req({ 'x-token': t }), t), null);
});

test('checkToken 缺失时以 401 拒绝（SEC-06）', () => {
  const e = checkToken(req({}), generateToken());
  assert.equal(e.status, 401);
  assert.equal(e.code, 'INVALID_TOKEN');
});

test('checkToken 不一致时以 401 拒绝', () => {
  const e = checkToken(req({ 'x-token': 'a'.repeat(64) }), generateToken());
  assert.equal(e.status, 401);
});

test('checkToken 长度不同时不抛出', () => {
  const e = checkToken(req({ 'x-token': 'short' }), generateToken());
  assert.equal(e.status, 401);
});

test('checkOrigin 一致时通过', () => {
  const o = 'http://127.0.0.1:7788';
  assert.equal(checkOrigin(req({ origin: o }), o), null);
});

test('checkOrigin 缺失时以 403 拒绝（SEC-07）', () => {
  const e = checkOrigin(req({}), 'http://127.0.0.1:7788');
  assert.equal(e.status, 403);
  assert.equal(e.code, 'BAD_ORIGIN');
});

test('checkOrigin 不一致时以 403 拒绝', () => {
  const e = checkOrigin(req({ origin: 'http://evil.example' }), 'http://127.0.0.1:7788');
  assert.equal(e.status, 403);
});

const adapter = { actions: { update: { destructive: false }, uninstall: { destructive: true } } };

test('checkAction 已声明时通过', () => {
  assert.equal(checkAction(adapter, 'update'), null);
});

test('checkAction 未声明时以 400 拒绝（SEC-08）', () => {
  const e = checkAction(adapter, 'evil');
  assert.equal(e.status, 400);
  assert.equal(e.code, 'UNKNOWN_ACTION');
});

test('checkAction 拒绝原型链上的键', () => {
  const e = checkAction(adapter, 'constructor');
  assert.equal(e.code, 'UNKNOWN_ACTION');
});

test('checkItemId 存在时通过', () => {
  assert.equal(checkItemId(new Map([['ripgrep', {}]]), 'ripgrep'), null);
});

test('checkItemId 不存在时以 409 拒绝（SEC-09）', () => {
  const e = checkItemId(new Map(), 'ripgrep');
  assert.equal(e.status, 409);
  assert.equal(e.code, 'STALE_ITEM');
});

test('checkItemId 清单未取得时以 409 拒绝', () => {
  const e = checkItemId(undefined, 'ripgrep');
  assert.equal(e.status, 409);
});

test('checkConfirm 非破坏性操作无需确认', () => {
  assert.equal(checkConfirm(adapter.actions.update, {}), null);
});

test('checkConfirm 破坏性操作有确认时通过', () => {
  assert.equal(checkConfirm(adapter.actions.uninstall, { confirm: true }), null);
});

test('checkConfirm 破坏性操作缺确认时以 400 拒绝（SEC-10）', () => {
  const e = checkConfirm(adapter.actions.uninstall, {});
  assert.equal(e.status, 400);
  assert.equal(e.code, 'CONFIRM_REQUIRED');
});

test('checkConfirm 确认标记非 true 时拒绝', () => {
  assert.equal(checkConfirm(adapter.actions.uninstall, { confirm: 'yes' }).status, 400);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/security.test.js
```

Expected: FAIL，`Cannot find module '.../server/security.js'`

- [ ] **Step 3: 实装 `server/security.js`**

```js
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
```

> `Object.hasOwn` 而非 `in`：后者会让 `constructor`、`toString` 等原型链上的键通过白名单校验。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/security.test.js
```

Expected: PASS，19 tests

- [ ] **Step 5: 提交**

```bash
git add server/security.js test/security.test.js
git commit -m "feat: 安全校验模块（SEC-02、SEC-04、SEC-06～SEC-10）"
```

---

## Task 4: API 路由 — 生态清单

**Files:**
- Create: `server/routes.js`
- Test: `test/routes.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `test/routes.test.js`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/routes.test.js
```

Expected: FAIL，`Cannot find module '.../server/routes.js'`

- [ ] **Step 3: 实装 `server/routes.js`（仅生态清单）**

```js
import { checkToken } from './security.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function fail(res, status, code, message, detail = null) {
  send(res, status, { error: { code, message, detail } });
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

    return fail(res, 404, 'NOT_FOUND', '未知的端点。');
  };
}

export { send };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/routes.test.js
```

Expected: PASS，5 tests

- [ ] **Step 5: 提交**

```bash
git add server/routes.js test/routes.test.js
git commit -m "feat: API 路由 — 生态清单（FR-01～FR-03）"
```

---

## Task 5: API 路由 — 条目清单

**Files:**
- Modify: `server/routes.js`
- Modify: `test/routes.test.js`

- [ ] **Step 1: 追加失败的测试**

在 `test/routes.test.js` 末尾追加：

```js
test('GET items 返回条目清单', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, 'pkg-a');
});

test('GET items 未知生态返回 404', async () => {
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters/nope/items');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'UNKNOWN_ADAPTER');
});

test('GET items 超时时返回 504', async () => {
  const err = new Error('timeout'); err.code = 'TIMEOUT';
  const adapter = fakeAdapter({ list: async () => { throw err; } });
  const router = createRouter({ adapters: [adapter], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.error.code, 'TIMEOUT');
});

test('GET items 其他异常时返回 500', async () => {
  const adapter = fakeAdapter({ list: async () => { throw new Error('boom'); } });
  const router = createRouter({ adapters: [adapter], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters/fake/items');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/routes.test.js
```

Expected: FAIL，4 tests failing（404 NOT_FOUND 而非期待值）

- [ ] **Step 3: 在 `routes.js` 的 `return fail(res, 404, 'NOT_FOUND', ...)` 之前插入条目清单分支**

```js
    const itemsMatch = pathname.match(/^\/api\/adapters\/([^/]+)\/items$/);
    if (req.method === 'GET' && itemsMatch) {
      const adapter = byId(decodeURIComponent(itemsMatch[1]));
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/routes.test.js
```

Expected: PASS，9 tests

- [ ] **Step 5: 提交**

```bash
git add server/routes.js test/routes.test.js
git commit -m "feat: API 路由 — 条目清单（FR-05～FR-08、SEC-09 前提）"
```

---

## Task 6: API 路由 — 操作执行与排他控制

**Files:**
- Modify: `server/routes.js`
- Modify: `test/routes.test.js`

- [ ] **Step 1: 追加失败的测试**

在 `test/routes.test.js` 末尾追加：

```js
const POST = (body) => ({ method: 'POST', headers: { origin: ORIGIN }, body });

// 操作前必须先取得清单，否则 SEC-09 会拒绝
async function primed(adapter) {
  const router = createRouter({ adapters: [adapter], token: TOKEN, origin: ORIGIN });
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
  const router = createRouter({ adapters: [fakeAdapter()], token: TOKEN, origin: ORIGIN });
  const res = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(res.statusCode, 409);
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
  const second = await call(router, '/api/adapters/fake/actions/update', POST({ itemId: 'pkg-a' }));
  assert.equal(second.statusCode, 500);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/routes.test.js
```

Expected: FAIL，10 tests failing

- [ ] **Step 3: 在 `routes.js` 顶部扩充 import**

```js
import { checkToken, checkOrigin, checkAction, checkItemId, checkConfirm } from './security.js';
```

- [ ] **Step 4: 在 `routes.js` 中追加请求体读取函数（置于 `publicActions` 之后）**

```js
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
```

- [ ] **Step 5: 在 `return fail(res, 404, 'NOT_FOUND', ...)` 之前插入操作分支**

```js
    const actionMatch = pathname.match(/^\/api\/adapters\/([^/]+)\/actions\/([^/]+)$/);
    if (req.method === 'POST' && actionMatch) {
      const originErr = checkOrigin(req, origin);
      if (originErr) return fail(res, originErr.status, originErr.code, originErr.message);

      const adapter = byId(decodeURIComponent(actionMatch[1]));
      if (!adapter) return fail(res, 404, 'UNKNOWN_ADAPTER', '未知的生态。');

      const actionKey = decodeURIComponent(actionMatch[2]);
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
```

- [ ] **Step 6: 运行全部测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm test
```

Expected: PASS，全 85 tests（config 27 + exec 20 + security 19 + routes 19）

- [ ] **Step 7: 提交**

```bash
git add server/routes.js test/routes.test.js
git commit -m "feat: API 路由 — 操作执行与排他控制（FR-14～FR-21、SEC-07～SEC-10）"
```

---

## Task 7: 静态资源与启动入口

**Files:**
- Create: `server/static.js`
- Create: `server/index.js`
- Create: `server/adapters/registry.js`
- Create: `web/index.html`（占位，Task 11 完成内容）
- Test: `test/static.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `test/static.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticPath } from '../server/static.js';

test('根路径映射到 index.html', () => {
  assert.equal(resolveStaticPath('/'), 'index.html');
});

test('允许顶层的 html/js/css', () => {
  assert.equal(resolveStaticPath('/app.js'), 'app.js');
  assert.equal(resolveStaticPath('/style.css'), 'style.css');
});

test('拒绝含路径分隔符的请求', () => {
  assert.equal(resolveStaticPath('/sub/app.js'), null);
});

test('拒绝上级目录穿越', () => {
  assert.equal(resolveStaticPath('/../server/index.js'), null);
  assert.equal(resolveStaticPath('/..%2Fserver'), null);
});

test('拒绝未知扩展名', () => {
  assert.equal(resolveStaticPath('/secret.env'), null);
  assert.equal(resolveStaticPath('/noext'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/static.test.js
```

Expected: FAIL，`Cannot find module '.../server/static.js'`

- [ ] **Step 3: 实装 `server/static.js`**

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function resolveStaticPath(pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/static.test.js
```

Expected: PASS，5 tests

- [ ] **Step 5: 创建空的适配器注册表**

创建 `server/adapters/registry.js`：

```js
export const adapters = [];
```

- [ ] **Step 6: 创建占位页面**

创建 `web/index.html`：

```html
<!doctype html>
<meta charset="utf-8">
<title>os-tool-manager</title>
<p>启动确认用占位页面。</p>
```

- [ ] **Step 7: 实装 `server/index.js`**

```js
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';
import { generateToken } from './security.js';
import { createRouter } from './routes.js';
import { createStatic } from './static.js';
import { adapters } from './adapters/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const config = getConfig();
const token = generateToken();
const origin = `http://127.0.0.1:${config.PORT}`;

const handleApi = createRouter({ adapters, token, origin, config });
const handleStatic = createStatic(join(root, 'web'));

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, origin).pathname;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await handleStatic(req, res, pathname);
    }
  } catch (e) {
    if (res.headersSent) return;
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: '服务器内部错误。', detail: e.message } }));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.PORT} 已被占用。`);
    console.error(`请在 .env 中设置 PORT=<其他端口> 后重新启动。`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(config.PORT, '127.0.0.1', () => {
  const url = `${origin}/?token=${token}`;
  console.log('os-tool-manager 已启动');
  console.log(url);
  if (config.AUTO_OPEN_BROWSER) {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
});
```

> `config` 传入 `createRouter` 供后续适配器使用超时配置。当前 `createRouter` 忽略该参数，Task 8 起使用。

- [ ] **Step 8: 手动确认启动**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm start
```

Expected: 打印 `os-tool-manager 已启动` 与含 token 的 URL，浏览器打开占位页面。确认后 `Ctrl+C` 停止。

- [ ] **Step 9: 手动确认端口占用时的行为（NFR-14）**

在另一个终端保持 `npm start` 运行的状态下再次执行：

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm start
```

Expected: 打印「端口 7788 已被占用。」与变更方法，退出码 1。

- [ ] **Step 10: 提交**

```bash
git add server/static.js server/index.js server/adapters/registry.js web/index.html test/static.test.js
git commit -m "feat: 静态资源与启动入口（SEC-01、SEC-03、SEC-05、NFR-13、NFR-14）"
```

---

## Task 8: Homebrew 适配器

**Files:**
- Create: `server/adapters/homebrew.js`
- Modify: `server/adapters/registry.js`
- Test: `test/homebrew.test.js`

**命令与输出格式：**

| 用途 | 命令 |
|---|---|
| formula 清单 | `brew list --formula --versions` → `ripgrep 14.1.0` |
| cask 清单 | `brew list --cask --versions` → `iterm2 3.5.0` |
| 过时清单 | `brew outdated --json=v2` → `{ "formulae": [{name, current_version}], "casks": [{name, current_version}] }` |
| 更新 | `brew upgrade --formula <name>` / `brew upgrade --cask <name>` |
| 卸载 | `brew uninstall --formula <name>` / `brew uninstall --cask <name>` |

`brew` 以命令名调用，不写绝对路径（NFR-12）。

- [ ] **Step 1: 写失败的测试**

创建 `test/homebrew.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersions, parseOutdated, buildItems, commandArgs } from '../server/adapters/homebrew.js';

test('parseVersions 解析名称与版本', () => {
  assert.deepEqual(parseVersions('ripgrep 14.1.0\nhtop 3.3.0\n'), [
    { name: 'ripgrep', current: '14.1.0' },
    { name: 'htop', current: '3.3.0' },
  ]);
});

test('parseVersions 多版本时取最后一个', () => {
  assert.deepEqual(parseVersions('openssl@3 3.4.0 3.5.1\n'), [{ name: 'openssl@3', current: '3.5.1' }]);
});

test('parseVersions 忽略空行', () => {
  assert.deepEqual(parseVersions('\n\nhtop 3.3.0\n\n'), [{ name: 'htop', current: '3.3.0' }]);
});

test('parseVersions 空输入返回空数组', () => {
  assert.deepEqual(parseVersions(''), []);
});

test('parseOutdated 分别解析 formula 与 cask', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'node', current_version: '25.10.0' }],
    casks: [{ name: 'rectangle', current_version: '0.90' }],
  });
  const m = parseOutdated(json);
  assert.equal(m.get('formula:node'), '25.10.0');
  assert.equal(m.get('cask:rectangle'), '0.90');
});

test('parseOutdated 输出非 JSON 时返回空 Map', () => {
  assert.equal(parseOutdated('not json').size, 0);
});

test('parseOutdated 缺少字段时不抛出', () => {
  assert.equal(parseOutdated('{}').size, 0);
});

test('buildItems 过时条目状态为 outdated', () => {
  const items = buildItems(
    [{ name: 'node', current: '25.9.0' }],
    [],
    new Map([['formula:node', '25.10.0']])
  );
  assert.equal(items[0].id, 'formula:node');
  assert.equal(items[0].name, 'node');
  assert.equal(items[0].status, 'outdated');
  assert.equal(items[0].latest, '25.10.0');
  assert.deepEqual(items[0].actions, ['update', 'uninstall']);
});

test('buildItems 最新条目状态为 ok 且 latest 等于 current', () => {
  const items = buildItems([{ name: 'htop', current: '3.3.0' }], [], new Map());
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].latest, '3.3.0');
});

test('buildItems cask 使用 cask 前缀', () => {
  const items = buildItems([], [{ name: 'iterm2', current: '3.5.0' }], new Map());
  assert.equal(items[0].id, 'cask:iterm2');
});

test('buildItems 的 active 恒为 null（FR-08 无适用）', () => {
  const items = buildItems([{ name: 'htop', current: '3.3.0' }], [], new Map());
  assert.equal(items[0].active, null);
});

test('buildItems formula 与 cask 同名时 ID 仍唯一', () => {
  const items = buildItems([{ name: 'x', current: '1' }], [{ name: 'x', current: '2' }], new Map());
  assert.deepEqual(items.map((i) => i.id), ['formula:x', 'cask:x']);
});

test('commandArgs 依 ID 前缀生成参数', () => {
  assert.deepEqual(commandArgs('upgrade', 'formula:node'), ['upgrade', '--formula', 'node']);
  assert.deepEqual(commandArgs('uninstall', 'cask:iterm2'), ['uninstall', '--cask', 'iterm2']);
});

test('commandArgs 未知前缀时抛出', () => {
  assert.throws(() => commandArgs('upgrade', 'bogus:x'));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/homebrew.test.js
```

Expected: FAIL，`Cannot find module '.../server/adapters/homebrew.js'`

- [ ] **Step 3: 实装 `server/adapters/homebrew.js`**

```js
import { run, ExecError } from '../exec.js';
import { getConfig } from '../config.js';

const listOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};
const actionOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};

export function parseVersions(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    out.push({ name: parts[0], current: parts[parts.length - 1] });
  }
  return out;
}

export function parseOutdated(stdout) {
  const map = new Map();
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return map;
  }
  for (const [key, prefix] of [['formulae', 'formula'], ['casks', 'cask']]) {
    for (const entry of data?.[key] ?? []) {
      if (entry?.name) map.set(`${prefix}:${entry.name}`, entry.current_version ?? null);
    }
  }
  return map;
}

export function buildItems(formulae, casks, outdated) {
  const build = (prefix) => (pkg) => {
    const id = `${prefix}:${pkg.name}`;
    const latest = outdated.get(id);
    return {
      id,
      name: pkg.name,
      current: pkg.current,
      latest: latest ?? pkg.current,
      status: latest ? 'outdated' : 'ok',
      active: null,
      actions: ['update', 'uninstall'],
    };
  };
  return [...formulae.map(build('formula')), ...casks.map(build('cask'))];
}

export function commandArgs(subcommand, itemId) {
  const sep = itemId.indexOf(':');
  const kind = itemId.slice(0, sep);
  const name = itemId.slice(sep + 1);
  if (kind !== 'formula' && kind !== 'cask') {
    throw new ExecError('BAD_ITEM_ID', `无法识别的条目 ID：${itemId}`);
  }
  return [subcommand, `--${kind}`, name];
}

export default {
  id: 'homebrew',
  label: 'Homebrew',

  async detect() {
    try {
      const r = await run('brew', ['--version'], { timeoutMs: 5000, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    const [formulaOut, caskOut, outdatedOut] = await Promise.all([
      run('brew', ['list', '--formula', '--versions'], listOpts()),
      run('brew', ['list', '--cask', '--versions'], listOpts()),
      run('brew', ['outdated', '--json=v2'], listOpts()),
    ]);
    return buildItems(
      parseVersions(formulaOut.stdout),
      parseVersions(caskOut.stdout),
      parseOutdated(outdatedOut.stdout)
    );
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('brew', commandArgs('upgrade', item.id), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('brew', commandArgs('uninstall', item.id), actionOpts()),
    },
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/homebrew.test.js
```

Expected: PASS，14 tests

- [ ] **Step 5: 注册适配器**

将 `server/adapters/registry.js` 全文替换为：

```js
import homebrew from './homebrew.js';

export const adapters = [homebrew];
```

- [ ] **Step 6: 手动确认真实数据**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node -e "import('./server/adapters/homebrew.js').then(async m => { const a = m.default; console.log('detect:', await a.detect()); const items = await a.list(); console.log('件数:', items.length); console.log('过时:', items.filter(i => i.status === 'outdated').length); console.log(items.slice(0, 3)); })"
```

Expected: `detect: true`，件数 43 前后，过时 26 前后（实机调查时点的值）

- [ ] **Step 7: 提交**

```bash
git add server/adapters/homebrew.js server/adapters/registry.js test/homebrew.test.js
git commit -m "feat: Homebrew 适配器（SC-01）"
```

---

## Task 9: npm 全局包适配器

**Files:**
- Create: `server/adapters/npm.js`
- Modify: `server/adapters/registry.js`
- Test: `test/npm.test.js`

**命令与注意点：**

| 用途 | 命令 |
|---|---|
| 清单 | `npm ls -g --depth=0 --json` → `{ "dependencies": { "pkg": { "version": "1.0.0" } } }` |
| 过时 | `npm outdated -g --json` → `{ "pkg": { "current": "1.0.0", "latest": "1.1.0" } }` |
| 更新 | `npm install -g <name>@latest` |
| 卸载 | `npm uninstall -g <name>` |

**重要：`npm outdated` 在存在过时包时退出码为 1。**不可将其视为失败，须只看 stdout。

- [ ] **Step 1: 写失败的测试**

创建 `test/npm.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlobalList, parseOutdated, buildItems } from '../server/adapters/npm.js';

test('parseGlobalList 解析依赖', () => {
  const json = JSON.stringify({ dependencies: { npm: { version: '11.12.1' }, tsx: { version: '4.0.0' } } });
  assert.deepEqual(parseGlobalList(json), [
    { name: 'npm', current: '11.12.1' },
    { name: 'tsx', current: '4.0.0' },
  ]);
});

test('parseGlobalList 无依赖时返回空数组', () => {
  assert.deepEqual(parseGlobalList('{}'), []);
});

test('parseGlobalList 非 JSON 时返回空数组', () => {
  assert.deepEqual(parseGlobalList('npm ERR!'), []);
});

test('parseGlobalList 跳过缺少 version 的项', () => {
  const json = JSON.stringify({ dependencies: { broken: {}, ok: { version: '1.0.0' } } });
  assert.deepEqual(parseGlobalList(json), [{ name: 'ok', current: '1.0.0' }]);
});

test('parseOutdated 解析最新版本', () => {
  const json = JSON.stringify({ tsx: { current: '4.0.0', latest: '4.1.0' } });
  assert.equal(parseOutdated(json).get('tsx'), '4.1.0');
});

test('parseOutdated 空输出返回空 Map', () => {
  assert.equal(parseOutdated('').size, 0);
});

test('parseOutdated 非 JSON 时返回空 Map', () => {
  assert.equal(parseOutdated('npm ERR!').size, 0);
});

test('buildItems 过时时状态为 outdated', () => {
  const items = buildItems([{ name: 'tsx', current: '4.0.0' }], new Map([['tsx', '4.1.0']]));
  assert.equal(items[0].id, 'tsx');
  assert.equal(items[0].status, 'outdated');
  assert.equal(items[0].latest, '4.1.0');
  assert.equal(items[0].active, null);
  assert.deepEqual(items[0].actions, ['update', 'uninstall']);
});

test('buildItems 最新时状态为 ok', () => {
  const items = buildItems([{ name: 'tsx', current: '4.0.0' }], new Map());
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].latest, '4.0.0');
});

test('buildItems 对 npm 自身不提供卸载', () => {
  const items = buildItems([{ name: 'npm', current: '11.12.1' }], new Map());
  assert.deepEqual(items[0].actions, ['update']);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/npm.test.js
```

Expected: FAIL，`Cannot find module '.../server/adapters/npm.js'`

- [ ] **Step 3: 实装 `server/adapters/npm.js`**

```js
import { run } from '../exec.js';
import { getConfig } from '../config.js';

const listOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};
const actionOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};

export function parseGlobalList(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  return Object.entries(data?.dependencies ?? {})
    .filter(([, v]) => v?.version)
    .map(([name, v]) => ({ name, current: v.version }));
}

export function parseOutdated(stdout) {
  const map = new Map();
  if (!stdout.trim()) return map;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return map;
  }
  for (const [name, info] of Object.entries(data ?? {})) {
    if (info?.latest) map.set(name, info.latest);
  }
  return map;
}

export function buildItems(packages, outdated) {
  return packages.map((pkg) => {
    const latest = outdated.get(pkg.name);
    return {
      id: pkg.name,
      name: pkg.name,
      current: pkg.current,
      latest: latest ?? pkg.current,
      status: latest ? 'outdated' : 'ok',
      active: null,
      // npm 自身卸载后将无法再操作，故不提供卸载
      actions: pkg.name === 'npm' ? ['update'] : ['update', 'uninstall'],
    };
  });
}

export default {
  id: 'npm',
  label: 'npm 全局包',

  async detect() {
    try {
      const r = await run('npm', ['--version'], { timeoutMs: 10000, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    // npm ls -g 在有 extraneous 包时退出码非 0，npm outdated 有过时包时退出码为 1。
    // 两者均只看 stdout，不以 ok 判断成败。
    const [listOut, outdatedOut] = await Promise.all([
      run('npm', ['ls', '-g', '--depth=0', '--json'], listOpts()),
      run('npm', ['outdated', '-g', '--json'], listOpts()),
    ]);
    return buildItems(parseGlobalList(listOut.stdout), parseOutdated(outdatedOut.stdout));
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('npm', ['install', '-g', `${item.name}@latest`], actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('npm', ['uninstall', '-g', item.name], actionOpts()),
    },
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/npm.test.js
```

Expected: PASS，10 tests

- [ ] **Step 5: 注册适配器**

将 `server/adapters/registry.js` 全文替换为：

```js
import homebrew from './homebrew.js';
import npm from './npm.js';

export const adapters = [homebrew, npm];
```

- [ ] **Step 6: 手动确认真实数据**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node -e "import('./server/adapters/npm.js').then(async m => { const a = m.default; console.log('detect:', await a.detect()); console.log(await a.list()); })"
```

Expected: `detect: true`，包含 `npm`、`@deepseek-ai/dsh`、`@fission-ai/openspec` 三件

- [ ] **Step 7: 提交**

```bash
git add server/adapters/npm.js server/adapters/registry.js test/npm.test.js
git commit -m "feat: npm 全局包适配器（SC-02）"
```

---

## Task 10: pip 用户级包适配器

**Files:**
- Create: `server/adapters/pip.js`
- Modify: `server/adapters/registry.js`
- Test: `test/pip.test.js`

**命令与注意点：**

| 用途 | 命令 |
|---|---|
| 清单 | `python3 -m pip list --user --format=json` → `[{"name":"numpy","version":"1.26.4"}]` |
| 过时 | `python3 -m pip list --user --outdated --format=json` → `[{"name":"numpy","version":"1.26.4","latest_version":"2.0.0"}]` |
| 更新 | `python3 -m pip install --user --upgrade <name>` |
| 卸载 | `python3 -m pip uninstall -y <name>` |

以 `python3 -m pip` 调用而非 `pip3`，确保与解释器一致（NFR-12）。

**性能上的注意：**本机 pip 用户级包约 180 件，`--outdated` 需对全部包查询 PyPI，可能超过 `LIST_TIMEOUT_MS` 的 60 秒。Task 12 中实测，若超时则将 `.env` 的 `LIST_TIMEOUT_MS` 调大至 180000。

- [ ] **Step 1: 写失败的测试**

创建 `test/pip.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parseOutdated, buildItems } from '../server/adapters/pip.js';

test('parseList 解析名称与版本', () => {
  const json = JSON.stringify([{ name: 'numpy', version: '1.26.4' }, { name: 'torch', version: '2.2.2' }]);
  assert.deepEqual(parseList(json), [
    { name: 'numpy', current: '1.26.4' },
    { name: 'torch', current: '2.2.2' },
  ]);
});

test('parseList 空数组返回空数组', () => {
  assert.deepEqual(parseList('[]'), []);
});

test('parseList 非 JSON 时返回空数组', () => {
  assert.deepEqual(parseList('ERROR: something'), []);
});

test('parseList 非数组时返回空数组', () => {
  assert.deepEqual(parseList('{"a":1}'), []);
});

test('parseOutdated 解析最新版本', () => {
  const json = JSON.stringify([{ name: 'numpy', version: '1.26.4', latest_version: '2.0.0' }]);
  assert.equal(parseOutdated(json).get('numpy'), '2.0.0');
});

test('parseOutdated 非 JSON 时返回空 Map', () => {
  assert.equal(parseOutdated('ERROR').size, 0);
});

test('buildItems 过时时状态为 outdated', () => {
  const items = buildItems([{ name: 'numpy', current: '1.26.4' }], new Map([['numpy', '2.0.0']]));
  assert.equal(items[0].id, 'numpy');
  assert.equal(items[0].status, 'outdated');
  assert.equal(items[0].latest, '2.0.0');
  assert.equal(items[0].active, null);
  assert.deepEqual(items[0].actions, ['update', 'uninstall']);
});

test('buildItems 最新时状态为 ok', () => {
  const items = buildItems([{ name: 'numpy', current: '1.26.4' }], new Map());
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].latest, '1.26.4');
});

test('buildItems 按名称排序', () => {
  const items = buildItems([{ name: 'zstandard', current: '1' }, { name: 'attrs', current: '2' }], new Map());
  assert.deepEqual(items.map((i) => i.name), ['attrs', 'zstandard']);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/pip.test.js
```

Expected: FAIL，`Cannot find module '.../server/adapters/pip.js'`

- [ ] **Step 3: 实装 `server/adapters/pip.js`**

```js
import { run } from '../exec.js';
import { getConfig } from '../config.js';

const listOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};
const actionOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};

function parseJsonArray(stdout) {
  try {
    const data = JSON.parse(stdout);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function parseList(stdout) {
  return parseJsonArray(stdout)
    .filter((e) => e?.name && e?.version)
    .map((e) => ({ name: e.name, current: e.version }));
}

export function parseOutdated(stdout) {
  const map = new Map();
  for (const e of parseJsonArray(stdout)) {
    if (e?.name && e?.latest_version) map.set(e.name, e.latest_version);
  }
  return map;
}

export function buildItems(packages, outdated) {
  return [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg) => {
      const latest = outdated.get(pkg.name);
      return {
        id: pkg.name,
        name: pkg.name,
        current: pkg.current,
        latest: latest ?? pkg.current,
        status: latest ? 'outdated' : 'ok',
        active: null,
        actions: ['update', 'uninstall'],
      };
    });
}

export default {
  id: 'pip',
  label: 'pip 用户级包',

  async detect() {
    try {
      const r = await run('python3', ['-m', 'pip', '--version'], { timeoutMs: 10000, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    const [listOut, outdatedOut] = await Promise.all([
      run('python3', ['-m', 'pip', 'list', '--user', '--format=json'], listOpts()),
      run('python3', ['-m', 'pip', 'list', '--user', '--outdated', '--format=json'], listOpts()),
    ]);
    return buildItems(parseList(listOut.stdout), parseOutdated(outdatedOut.stdout));
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('python3', ['-m', 'pip', 'install', '--user', '--upgrade', item.name], actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('python3', ['-m', 'pip', 'uninstall', '-y', item.name], actionOpts()),
    },
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node --test test/pip.test.js
```

Expected: PASS，9 tests

- [ ] **Step 5: 注册适配器**

将 `server/adapters/registry.js` 全文替换为：

```js
import homebrew from './homebrew.js';
import npm from './npm.js';
import pip from './pip.js';

export const adapters = [homebrew, npm, pip];
```

- [ ] **Step 6: 实测 `--outdated` 的所要时间**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && time python3 -m pip list --user --outdated --format=json > /dev/null
```

Expected: 输出所要时间。若超过 55 秒，则在 `.env` 中设置 `LIST_TIMEOUT_MS=180000`（`.env` 不存在时从 `.env.example` 复制）。

- [ ] **Step 7: 手动确认真实数据**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && node -e "import('./server/adapters/pip.js').then(async m => { const a = m.default; console.log('detect:', await a.detect()); const items = await a.list(); console.log('件数:', items.length); console.log('过时:', items.filter(i => i.status === 'outdated').length); })"
```

Expected: `detect: true`，件数 180 前后

- [ ] **Step 8: 提交**

```bash
git add server/adapters/pip.js server/adapters/registry.js test/pip.test.js
git commit -m "feat: pip 用户级包适配器（SC-03）"
```

---

## Task 11: 前端

**Files:**
- Modify: `web/index.html`
- Create: `web/style.css`
- Create: `web/app.js`

- [ ] **Step 1: 实装 `web/index.html`**

全文替换为：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>os-tool-manager</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>os-tool-manager</h1>
    <p id="status">读取中…</p>
  </header>
  <main id="cards"></main>
  <dialog id="confirm-dialog">
    <form method="dialog">
      <p id="confirm-text"></p>
      <menu>
        <button value="cancel">取消</button>
        <button value="ok" class="danger">执行</button>
      </menu>
    </form>
  </dialog>
  <dialog id="output-dialog">
    <h2 id="output-title"></h2>
    <pre id="output-body"></pre>
    <form method="dialog"><button>关闭</button></form>
  </dialog>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 实装 `web/style.css`**

```css
:root {
  --bg: #fff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
  --ok: #2da44e; --warn: #bf8700; --danger: #cf222e; --surface: #f9fafb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #30363d;
    --ok: #3fb950; --warn: #d29922; --danger: #f85149; --surface: #161b22;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
}
header { padding: 20px 24px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 4px; font-size: 18px; }
#status { margin: 0; color: var(--muted); font-size: 13px; }
main { padding: 20px 24px 60px; display: grid; gap: 20px; }
.card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.card-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border);
}
.card-head h2 { margin: 0; font-size: 15px; flex: 1; }
.count { color: var(--muted); font-size: 12px; }
.card-body { max-height: 420px; overflow-y: auto; }
.row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 16px; border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: none; }
.row.busy { opacity: 0.5; }
.name { flex: 1; font-weight: 500; word-break: break-all; }
.ver { color: var(--muted); font-size: 12px; font-family: ui-monospace, Menlo, monospace; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid currentColor; }
.badge.ok { color: var(--ok); }
.badge.outdated { color: var(--warn); }
.badge.unknown { color: var(--muted); }
button {
  font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
  background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-radius: 5px;
}
button:hover:not(:disabled) { background: var(--surface); }
button:disabled { opacity: 0.4; cursor: default; }
button.danger { color: var(--danger); border-color: var(--danger); }
.msg { padding: 14px 16px; color: var(--muted); }
.msg.error { color: var(--danger); white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
dialog { border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); max-width: min(80vw, 760px); }
dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
dialog menu { display: flex; gap: 8px; justify-content: flex-end; padding: 0; margin: 16px 0 0; }
#output-body { max-height: 55vh; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: 12px; background: var(--surface); padding: 12px; border-radius: 6px; }
```

- [ ] **Step 3: 实装 `web/app.js`**

```js
// 令牌取得后立即从地址栏移除（SEC-13）
const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
if (params.has('token')) {
  params.delete('token');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
}

const statusEl = document.getElementById('status');
const cardsEl = document.getElementById('cards');
const confirmDialog = document.getElementById('confirm-dialog');
const confirmText = document.getElementById('confirm-text');
const outputDialog = document.getElementById('output-dialog');
const outputTitle = document.getElementById('output-title');
const outputBody = document.getElementById('output-body');

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'x-token': token, 'content-type': 'application/json', ...options.headers },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    err.detail = data?.error?.detail ?? null;
    throw err;
  }
  return data;
}

function showOutput(title, result) {
  outputTitle.textContent = title;
  outputBody.textContent = [result.stdout, result.stderr].filter(Boolean).join('\n') || '（无输出）';
  outputDialog.showModal();
}

function askConfirm(text) {
  confirmText.textContent = text;
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
  });
}

class Card {
  constructor(adapter) {
    this.adapter = adapter;
    this.items = null;   // 先前取得的内容。取得中也保留显示（FR-11）
    this.el = document.createElement('section');
    this.el.className = 'card';
    this.el.innerHTML = `
      <div class="card-head">
        <h2></h2>
        <span class="count"></span>
        <button class="refresh">刷新</button>
      </div>
      <div class="card-body"></div>`;
    this.el.querySelector('h2').textContent = adapter.label;
    this.countEl = this.el.querySelector('.count');
    this.bodyEl = this.el.querySelector('.card-body');
    this.refreshBtn = this.el.querySelector('.refresh');
    this.refreshBtn.addEventListener('click', () => this.load());   // FR-12
  }

  setCount(text) { this.countEl.textContent = text; }

  async load() {
    this.refreshBtn.disabled = true;
    this.setCount('取得中…');
    if (!this.items) this.bodyEl.innerHTML = '<p class="msg">取得中…</p>';
    try {
      const { items } = await api(`/api/adapters/${encodeURIComponent(this.adapter.id)}/items`);
      this.items = items;
      this.render();
    } catch (e) {
      // ERR-01: 仅本卡片显示错误，不影响其他卡片
      this.setCount('取得失败');
      this.bodyEl.innerHTML = '';
      const msg = document.createElement('p');
      msg.className = 'msg error';
      msg.textContent = [e.message, e.detail].filter(Boolean).join('\n\n');
      const retry = document.createElement('button');
      retry.textContent = '重试';
      retry.addEventListener('click', () => this.load());
      this.bodyEl.append(msg, retry);
    } finally {
      this.refreshBtn.disabled = false;
    }
  }

  render() {
    const outdated = this.items.filter((i) => i.status === 'outdated').length;
    this.setCount(`${this.items.length} 件${outdated ? ` · ${outdated} 件有更新` : ''}`);
    this.bodyEl.innerHTML = '';
    if (!this.items.length) {
      this.bodyEl.innerHTML = '<p class="msg">无条目。</p>';
      return;
    }
    for (const item of this.items) this.bodyEl.append(this.renderRow(item));
  }

  renderRow(item) {
    const row = document.createElement('div');
    row.className = 'row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name + (item.active ? '（当前生效）' : '');   // FR-08

    const ver = document.createElement('span');
    ver.className = 'ver';
    ver.textContent = item.status === 'outdated' ? `${item.current} → ${item.latest}` : item.current;

    const badge = document.createElement('span');
    badge.className = `badge ${item.status}`;
    badge.textContent = { ok: '最新', outdated: '有更新', unknown: '未知' }[item.status];

    row.append(name, ver, badge);

    // FR-13: 依 actions 动态渲染
    for (const key of item.actions) {
      const meta = this.adapter.actions[key];
      if (!meta) continue;
      const btn = document.createElement('button');
      btn.textContent = meta.label;
      if (meta.destructive) btn.classList.add('danger');
      btn.addEventListener('click', () => this.runAction(item, key, meta, row));
      row.append(btn);
    }
    return row;
  }

  setBusy(busy) {
    // FR-18: 执行中禁用本卡片全部按钮
    for (const b of this.el.querySelectorAll('button')) b.disabled = busy;
    this.el.classList.toggle('busy', busy);
  }

  async runAction(item, key, meta, row) {
    if (meta.destructive) {
      const ok = await askConfirm(`确定要对「${item.name}」执行${meta.label}吗？此操作不可撤销。`);
      if (!ok) return;   // FR-17: 不发送请求
    }
    this.setBusy(true);
    row.classList.add('busy');
    try {
      const result = await api(
        `/api/adapters/${encodeURIComponent(this.adapter.id)}/actions/${encodeURIComponent(key)}`,
        { method: 'POST', body: JSON.stringify({ itemId: item.id, confirm: meta.destructive ? true : undefined }) }
      );
      if (!result.ok) showOutput(`${item.name} 的${meta.label}失败`, result);   // FR-21
      this.setBusy(false);
      row.classList.remove('busy');
      await this.load();   // FR-20
      return;
    } catch (e) {
      showOutput(`${item.name} ${meta.label}失败`, { stdout: '', stderr: [e.message, e.detail].filter(Boolean).join('\n\n') });
    }
    this.setBusy(false);
    row.classList.remove('busy');
  }
}

async function main() {
  try {
    const { adapters } = await api('/api/adapters');
    if (!adapters.length) {
      statusEl.textContent = '本机未检测到可管理的生态。';
      return;
    }
    statusEl.textContent = `${adapters.length} 个生态可用`;
    const cards = adapters.map((a) => new Card(a));
    for (const c of cards) cardsEl.append(c.el);
    // FR-09: 并发取得
    await Promise.all(cards.map((c) => c.load()));
  } catch (e) {
    statusEl.textContent = `初始化失败：${e.message}`;
  }
}

main();
```

- [ ] **Step 4: 启动并目视确认**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm start
```

Expected: 三张卡片（Homebrew、npm 全局包、pip 用户级包）显示。Homebrew 与 pip 取得中时 npm 卡片已完成显示。确认后 `Ctrl+C`。

- [ ] **Step 5: 提交**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "feat: 前端（FR-04～FR-21、SEC-13）"
```

---

## Task 12: 手动验证与文档整备

**Files:**
- Modify: `README.md`
- Create: `docs/reviews/2026-09-20-manual-verification.md`

- [ ] **Step 1: 执行全部自动测试**

```bash
cd /Users/ZHANGWENWEI/Documents/001_Dashboard/os-tool-manager && npm test
```

Expected: PASS，全 123 tests（config 27 + exec 20 + security 19 + routes 19 + static 5 + homebrew 14 + npm 10 + pip 9）

- [ ] **Step 2: 依要件书 9.3 节执行手动验证**

逐项确认，记录结果：

| # | 确认内容 | 要件 | 方法 |
|---|---|---|---|
| 1 | 终端打印含令牌的 URL，浏览器自动打开 | SEC-03 | `npm start` |
| 2 | 地址栏的 token 参数在载入后消失 | SEC-13 | 目视地址栏 |
| 3 | Homebrew 取得中时其他卡片已显示且可操作 | FR-10 | 目视 |
| 4 | 刷新期间旧内容保留并显示「取得中…」 | FR-11 | 点刷新按钮 |
| 5 | 卸载显示含对象名的确认，取消则不发送请求 | FR-15、FR-17 | 开发者工具 Network 标签确认无请求 |
| 6 | 操作执行中该卡片按钮全部禁用 | FR-18 | 目视 |
| 7 | 操作失败时原始输出完整显示 | FR-21 | 见 Step 3 |
| 8 | 端口占用时错误信息含变更方法 | NFR-14 | 见 Task 7 Step 9 |
| 9 | 令牌无效时 API 返回 401 | SEC-06 | 见 Step 4 |
| 10 | Origin 不正时 POST 返回 403 | SEC-07 | 见 Step 5 |

- [ ] **Step 3: 确认操作失败时的显示（FR-21）**

服务启动的状态下，在浏览器开发者工具的 Console 中执行（`<TOKEN>` 替换为启动时打印的令牌）：

```js
await fetch('/api/adapters/npm/actions/update', {
  method: 'POST',
  headers: { 'x-token': '<TOKEN>', 'content-type': 'application/json' },
  body: JSON.stringify({ itemId: 'npm' })
}).then(r => r.json())
```

先点一次 npm 卡片的刷新（使服务端持有条目清单），然后在界面上对一个不存在的包执行更新以确认失败输出。最简便的做法：暂时断网后点击任意「更新」，确认错误输出全文显示于对话框。

- [ ] **Step 4: 确认令牌校验（SEC-06）**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7788/api/adapters
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-token: wrong' http://127.0.0.1:7788/api/adapters
```

Expected: 两次均为 `401`

- [ ] **Step 5: 确认 Origin 校验（SEC-07）**

`<TOKEN>` 替换为启动时打印的令牌：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-token: <TOKEN>' -H 'content-type: application/json' -d '{"itemId":"npm"}' http://127.0.0.1:7788/api/adapters/npm/actions/update
```

Expected: `403`（`Origin` 缺失）

- [ ] **Step 6: 确认仅绑定回环地址（SEC-01）**

```bash
lsof -nP -iTCP:7788 -sTCP:LISTEN
```

Expected: 地址列为 `127.0.0.1:7788`，**不得**为 `*:7788`

- [ ] **Step 7: 记录验证结果**

创建 `docs/reviews/2026-09-20-manual-verification.md`，记录 Step 2 的表格与各项的实测结果（通过 / 失败 / 备注）。失败项在本任务内修正后重新验证。

- [ ] **Step 8: 更新 `README.md`**

全文替换为：

```markdown
# os-tool-manager

macOS 本地的工具管理面板。管理 Homebrew 包、npm 全局包、pip 用户级包的清单、版本、更新与卸载。

## 启动

```bash
npm start
```

终端会打印含访问令牌的 URL，浏览器自动打开。无需 `npm install`（零运行时依赖）。

## 要求

- macOS
- Node.js 20 以上

## 配置

全部配置项可省略。需要变更时将 `.env.example` 复制为 `.env` 后修改。

| 配置项 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `7788` | HTTP 服务端口 |
| `LIST_TIMEOUT_MS` | `60000` | 清单取得的超时 |
| `ACTION_TIMEOUT_MS` | `600000` | 操作执行的超时 |
| `MAX_OUTPUT_BYTES` | `1048576` | 输出保留上限 |
| `AUTO_OPEN_BROWSER` | `true` | 启动时自动打开浏览器 |

> pip 用户级包较多时 `--outdated` 的查询会很慢。若清单取得超时，请调大 `LIST_TIMEOUT_MS`。

## 安全

- 仅绑定 `127.0.0.1`，局域网内的其他机器无法访问
- `/api/*` 全部需要启动时生成的随机令牌
- POST 请求校验 `Origin`，阻止其他网页调用本地服务
- 操作种类与操作对象均经白名单校验，命令参数以数组传递，不经由 shell
- 不使用 `sudo`

## 测试

```bash
npm test
```

## 文档

- 要件定义书：`docs/specs/2026-09-20-os-tool-manager-requirements.md`
- 实装计划：`docs/plans/2026-09-20-os-tool-manager-implementation-plan.md`
- 审查报告：`docs/reviews/`
```

- [ ] **Step 9: 提交**

```bash
git add README.md docs/reviews/2026-09-20-manual-verification.md
git commit -m "docs: 手动验证结果与 README 整备"
```

---

## 要件覆盖对照

| 要件 | 实装位置 |
|---|---|
| FR-01～FR-03 | Task 4（`routes.js` 生态清单、探测异常处理） |
| FR-04～FR-08 | Task 5（服务端）、Task 11（`Card.render`、`renderRow`） |
| FR-09 | Task 11（`main` 的 `Promise.all`） |
| FR-10、FR-11 | Task 11（`Card.load` 的 `if (!this.items)` 分支） |
| FR-12 | Task 11（`refresh` 按钮） |
| FR-13 | Task 11（`renderRow` 的 `item.actions` 循环） |
| FR-14～FR-17 | Task 11（`runAction` 的 `askConfirm`） |
| FR-18 | Task 11（`setBusy`） |
| FR-19 | Task 6（`busy` Set 与 `BUSY` 错误） |
| FR-20 | Task 11（`runAction` 末尾的 `this.load()`） |
| FR-21 | Task 11（`showOutput`） |
| FR-22、FR-23 | 无持久化实装。状态仅存于 `routes.js` 的闭包 |
| NFR-01～NFR-04 | Task 1（`package.json`） |
| NFR-05、NFR-06 | Task 1（`config.js`） |
| NFR-07～NFR-09 | Task 2（`exec.js`） |
| NFR-10、NFR-11 | Task 4～6（`routes.js` 无生态名）、Task 8～10（适配器） |
| NFR-12 | Task 8～10（`brew`、`npm`、`python3 -m pip` 均以命令名调用） |
| NFR-13 | Task 7（`createServer` 的 try/catch） |
| NFR-14 | Task 7（`EADDRINUSE` 处理） |
| SEC-01、SEC-03 | Task 7（`listen(port, '127.0.0.1')`、URL 打印） |
| SEC-02 | Task 3（`generateToken`） |
| SEC-04～SEC-06 | Task 3、Task 4（`checkToken` 于路由入口） |
| SEC-05 | Task 7（`static.js` 不经令牌校验） |
| SEC-07～SEC-10 | Task 3、Task 6 |
| SEC-11 | Task 2（`spawn` 的 `shell: false`） |
| SEC-12 | 全程不使用 `sudo`。无实装对象 |
| SEC-13 | Task 11（`history.replaceState`） |
| ERR-01 | Task 11（`Card.load` 的 catch 分支） |
| 9.2 节 | Task 1～10 的各测试 |
| 9.3 节 | Task 12 |

---

## 自查结果

- **要件覆盖**：上表涵盖 FR-01～FR-23、NFR-01～NFR-14、SEC-01～SEC-13、ERR-01 全 51 件。SEC-12 为禁止事项，无对应实装。
- **占位符**：无 TBD / TODO。全部代码步骤均含完整代码。
- **类型一致性**：`Item`（`id`/`name`/`current`/`latest`/`status`/`active`/`actions`）在 Task 5、8、9、10、11 中一致；`ActionResult`（`ok`/`exitCode`/`stdout`/`stderr`/`truncated`）在 Task 2、6、11 中一致；`buildItems` 的签名在各适配器中统一为 `(packages, outdated)`（Homebrew 因有 formula/cask 之分为三参数，已于该任务的测试中明示）。
- **已知风险**：pip 的 `--outdated` 可能超过默认超时。Task 10 Step 6 中实测并指示对策。
