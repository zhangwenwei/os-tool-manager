import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import uvAdapter, { parseInstalled, latestInLine, buildItems, buildList, actionArgs } from '../server/adapters/uv.js';
import { AdapterError } from '../server/adapters/base.js';

const here = dirname(fileURLToPath(import.meta.url));
const installedOut = readFileSync(join(here, 'fixtures', 'uv-python-installed.json'), 'utf8');
const PY_DIR = '/Users/u/.local/share/uv/python';
const ok = (stdout) => ({ ok: true, exitCode: 0, stdout, stderr: '', truncated: false });

test('parseInstalled 按 key 去重', () => {
  assert.equal(parseInstalled(installedOut, PY_DIR).length, 1);
});

test('parseInstalled 排除系统 Python —— 不得对它提供卸载', () => {
  const r = parseInstalled(installedOut, PY_DIR);
  assert.ok(!r.some((e) => e.path.startsWith('/usr/bin')), '系统 Python 不应出现');
  assert.ok(!r.some((e) => e.version === '3.9.6'));
});

test('parseInstalled 去重时保留带符号链接的那条', () => {
  assert.ok(parseInstalled(installedOut, PY_DIR)[0].symlink, '应保留带 symlink 的记录以判定当前生效');
});

// 真实输出里带 symlink 的那条恰好在前，只断言原序会让「后来者不覆盖」的错误实装也通过。
test('parseInstalled 去重与记录先后无关，始终保留带符号链接的那条', () => {
  const reversed = JSON.stringify(JSON.parse(installedOut).reverse());
  const r = parseInstalled(reversed, PY_DIR);
  assert.equal(r.length, 1);
  assert.ok(r[0].symlink, '带 symlink 的记录在后时也应胜出');
});

test('parseInstalled 安装目录为空时一个都不返回', () => {
  assert.deepEqual(parseInstalled(installedOut, null), []);
  assert.deepEqual(parseInstalled(installedOut, ''), []);
});

test('parseInstalled 非 JSON 时抛出', () => {
  assert.throws(() => parseInstalled('not json', PY_DIR), (e) => e instanceof AdapterError && e.code === 'PARSE_FAILED');
});

test('parseInstalled 非数组时抛出', () => {
  assert.throws(() => parseInstalled('{"a":1}', PY_DIR), (e) => e.code === 'PARSE_FAILED');
});

// 真实的 uv 输出每条都带 implementation 与 variant，固件必须照此。
const avail = (versions) =>
  JSON.stringify(versions.map((v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return {
      key: `cpython-${v}`, version: v, version_parts: { major, minor, patch },
      implementation: 'cpython', variant: 'default',
    };
  }));

const entryOf = (major, minor) => ({
  version_parts: { major, minor, patch: 0 },
  implementation: 'cpython',
  variant: 'default',
});

test('latestInLine 只取同小版本线内的最大值', () => {
  const a = JSON.parse(avail(['3.11.0', '3.11.15', '3.11.16', '3.13.2']));
  assert.equal(latestInLine(a, entryOf(3, 11)), '3.11.16');
  assert.equal(latestInLine(a, entryOf(3, 13)), '3.13.2');
});

test('latestInLine 该线无版本时为 null', () => {
  assert.equal(latestInLine(JSON.parse(avail(['3.11.1'])), entryOf(3, 12)), null);
});

test('已是该线最新时状态为 ok', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), avail(['3.11.15', '3.11.16']));
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].latest, '3.11.16');
});

test('该线有更新时状态为 outdated', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), avail(['3.11.16', '3.11.17']));
  assert.equal(items[0].status, 'outdated');
  assert.equal(items[0].latest, '3.11.17');
});

test('跨小版本线的新版本不算更新', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), avail(['3.11.16', '3.13.5']));
  assert.equal(items[0].status, 'ok', '3.13 不应被当作 3.11 的更新');
});

// 补丁号更大的他线版本：若实装漏了 minor 过滤，这里会被误判为 outdated。
test('跨小版本线且补丁号更大的版本仍不算更新', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), avail(['3.11.16', '3.13.20']));
  assert.equal(items[0].status, 'ok', '3.13.20 不应被当作 3.11 的更新');
  assert.equal(items[0].latest, '3.11.16');
});

test('取不到可下载清单时状态为 unknown', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), null);
  assert.equal(items[0].status, 'unknown');
  assert.equal(items[0].latest, null);
});

test('有符号链接的版本标为当前生效（FR-08）', () => {
  assert.equal(buildItems(parseInstalled(installedOut, PY_DIR), avail(['3.11.16']))[0].active, true);
});

test('条目的 ID 为 uv 的 key，名称含实现与版本', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), avail(['3.11.16']));
  assert.equal(items[0].id, 'cpython-3.11.16-macos-x86_64-none');
  assert.match(items[0].name, /cpython 3\.11\.16/);
});

test('buildList 在已装清单失败时抛出', () => {
  assert.throws(
    () => buildList({ installed: { ok: false, exitCode: 1, stdout: '', stderr: '炸了', truncated: false }, available: ok('[]'), pythonDir: PY_DIR }),
    (e) => e.code === 'LIST_FAILED'
  );
});

test('buildList 在已装清单被截断时抛出', () => {
  assert.throws(
    () => buildList({ installed: { ok: true, exitCode: 0, stdout: '[]', stderr: '', truncated: true }, available: ok('[]'), pythonDir: PY_DIR }),
    (e) => e.code === 'LIST_TRUNCATED'
  );
});

test('buildList 在可下载清单失败时降级为 unknown 而非报错', () => {
  const items = buildList({
    installed: ok(installedOut),
    available: { ok: false, exitCode: 1, stdout: '', stderr: '网络不通', truncated: false },
    pythonDir: PY_DIR,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'unknown');
});

test('actionArgs 生成 uv python 子命令', () => {
  assert.deepEqual(actionArgs('upgrade', 'cpython-3.11.16-macos-x86_64-none'), ['python', 'upgrade', 'cpython-3.11.16-macos-x86_64-none']);
  assert.deepEqual(actionArgs('uninstall', 'cpython-3.11.16-macos-x86_64-none'), ['python', 'uninstall', 'cpython-3.11.16-macos-x86_64-none']);
});

test('actionArgs 拒绝非法标识', () => {
  for (const bad of ['', null, undefined, 123456, '--force', 'a b', 'a/b', 'x\n']) {
    assert.throws(() => actionArgs('uninstall', bad), (e) => e.code === 'BAD_ITEM_ID', `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('update 与 uninstall 各自生成对应的 uv 子命令，不得互换', () => {
  const key = 'cpython-3.11.16-macos-x86_64-none';
  assert.deepEqual(actionArgs('upgrade', key), ['python', 'upgrade', key]);
  assert.deepEqual(actionArgs('uninstall', key), ['python', 'uninstall', key]);
  assert.notDeepEqual(actionArgs('upgrade', key), actionArgs('uninstall', key));
});

test('安装目录为非字符串时一个都不返回（含空数组）', () => {
  for (const bad of [[], {}, 0, 123, true]) {
    assert.deepEqual(parseInstalled(installedOut, bad), [], `${JSON.stringify(bad)} 不应放行任何条目`);
  }
});

test('兄弟目录不得被当作安装目录的子路径', () => {
  const json = JSON.stringify([{
    key: 'cpython-9.9.9-x', version: '9.9.9',
    version_parts: { major: 9, minor: 9, patch: 9 },
    path: `${PY_DIR}-evil/bin/python3`, symlink: null, implementation: 'cpython', variant: 'default',
  }]);
  assert.deepEqual(parseInstalled(json, PY_DIR), []);
});

test('条目路径为非字符串时不放行', () => {
  const json = JSON.stringify([{
    key: 'cpython-9.9.9-x', version: '9.9.9',
    version_parts: { major: 9, minor: 9, patch: 9 },
    path: 12345, symlink: null, implementation: 'cpython', variant: 'default',
  }]);
  assert.deepEqual(parseInstalled(json, PY_DIR), []);
});

// 数字 12345 转成字符串也匹配不上前缀，挡不住「String(p).startsWith」这种强转实装。
// 数组才是真正的威胁：String([x]) === x，与 I-5 的 [] fail-open 是同一模式。
test('条目路径为数组时不因字符串强转而放行', () => {
  const json = JSON.stringify([{
    key: 'cpython-9.9.9-x', version: '9.9.9',
    version_parts: { major: 9, minor: 9, patch: 9 },
    path: [`${PY_DIR}/cpython-9.9.9/bin/python3`], symlink: null, implementation: 'cpython', variant: 'default',
  }]);
  assert.deepEqual(parseInstalled(json, PY_DIR), []);
});

test('不同实现的同版本号不得互相当作更新', () => {
  const installed = [{
    key: 'pypy-3.11.15-x', version: '3.11.15',
    version_parts: { major: 3, minor: 11, patch: 15 },
    implementation: 'pypy', variant: 'default', symlink: null,
  }];
  const available = JSON.stringify([
    { key: 'pypy-3.11.15-x', version: '3.11.15', version_parts: { major: 3, minor: 11, patch: 15 }, implementation: 'pypy', variant: 'default' },
    { key: 'cpython-3.11.16-x', version: '3.11.16', version_parts: { major: 3, minor: 11, patch: 16 }, implementation: 'cpython', variant: 'default' },
  ]);
  const items = buildItems(installed, available);
  assert.equal(items[0].latest, '3.11.15', 'cpython 的 3.11.16 不应成为 pypy 的最新版');
  assert.equal(items[0].status, 'ok');
});

test('不同变体的同版本号不得互相当作更新', () => {
  const installed = [{
    key: 'cpython-3.14.7+freethreaded-x', version: '3.14.7',
    version_parts: { major: 3, minor: 14, patch: 7 },
    implementation: 'cpython', variant: 'freethreaded', symlink: null,
  }];
  const available = JSON.stringify([
    { key: 'cpython-3.14.7+freethreaded-x', version: '3.14.7', version_parts: { major: 3, minor: 14, patch: 7 }, implementation: 'cpython', variant: 'freethreaded' },
    { key: 'cpython-3.14.8-x', version: '3.14.8', version_parts: { major: 3, minor: 14, patch: 8 }, implementation: 'cpython', variant: 'default' },
  ]);
  const items = buildItems(installed, available);
  assert.equal(items[0].latest, '3.14.7', 'default 变体的 3.14.8 不应成为 freethreaded 的最新版');
  assert.equal(items[0].status, 'ok');
});

test('预发布版本不因补丁号相同而被判为有更新', () => {
  const installed = [{
    key: 'cpython-3.15.0rc2-x', version: '3.15.0rc2',
    version_parts: { major: 3, minor: 15, patch: 0 },
    implementation: 'cpython', variant: 'default', symlink: null,
  }];
  const available = JSON.stringify([
    { key: 'cpython-3.15.0rc2-x', version: '3.15.0rc2', version_parts: { major: 3, minor: 15, patch: 0 }, implementation: 'cpython', variant: 'default' },
  ]);
  const items = buildItems(installed, available);
  assert.equal(items[0].latest, '3.15.0rc2', '不得由 version_parts 拼出目录中不存在的 3.15.0');
  assert.equal(items[0].status, 'ok');
});

test('同补丁号时正式版优先于预发布版', () => {
  const installed = [{
    key: 'cpython-3.15.0rc2-x', version: '3.15.0rc2',
    version_parts: { major: 3, minor: 15, patch: 0 },
    implementation: 'cpython', variant: 'default', symlink: null,
  }];
  const available = JSON.stringify([
    { key: 'cpython-3.15.0rc2-x', version: '3.15.0rc2', version_parts: { major: 3, minor: 15, patch: 0 }, implementation: 'cpython', variant: 'default' },
    { key: 'cpython-3.15.0-x', version: '3.15.0', version_parts: { major: 3, minor: 15, patch: 0 }, implementation: 'cpython', variant: 'default' },
  ]);
  const items = buildItems(installed, available);
  assert.equal(items[0].latest, '3.15.0');
  assert.equal(items[0].status, 'outdated');
});

test('可下载清单为非 JSON 时降级为 unknown 而非抛出', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), 'uv: error: no network');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'unknown');
  assert.equal(items[0].latest, null);
});

test('可下载清单为空字符串时降级为 unknown 而非抛出', () => {
  const items = buildItems(parseInstalled(installedOut, PY_DIR), '');
  assert.equal(items[0].status, 'unknown');
});

test('当前生效标记来自符号链接，而非恒定值', () => {
  const json = JSON.stringify([{
    key: 'cpython-3.12.0-x', version: '3.12.0',
    version_parts: { major: 3, minor: 12, patch: 0 },
    path: `${PY_DIR}/cpython-3.12.0/bin/python3`, symlink: null,
    implementation: 'cpython', variant: 'default',
  }]);
  assert.equal(buildItems(parseInstalled(json, PY_DIR), '[]')[0].active, false);
});

// 上面那条只比较 actionArgs 的返回值，杀不掉「update 的 run 改跑 uninstall」这个变异 ——
// 它没有碰过 adapter.actions.*.run。这里用 PATH 上的替身 uv 记录真实 argv，
// 替身只把参数写进文件就退出，不会执行任何真正的 uv 命令。
test('update 与 uninstall 的 run 各自派发对应子命令（记录真实 argv）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uv-stub-'));
  const log = join(dir, 'argv.log');
  writeFileSync(join(dir, 'uv'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  try {
    const key = 'cpython-3.11.16-macos-x86_64-none';
    await uvAdapter.actions.update.run({ id: key });
    await uvAdapter.actions.uninstall.run({ id: key });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(lines, [`python upgrade ${key}`, `python uninstall ${key}`]);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
