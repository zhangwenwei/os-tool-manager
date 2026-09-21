import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInstalled, latestInLine, buildItems, buildList, actionArgs } from '../server/adapters/uv.js';
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

const avail = (versions) =>
  JSON.stringify(versions.map((v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return { key: `cpython-${v}`, version: v, version_parts: { major, minor, patch }, implementation: 'cpython' };
  }));

test('latestInLine 只取同小版本线内的最大值', () => {
  const a = JSON.parse(avail(['3.11.0', '3.11.15', '3.11.16', '3.13.2']));
  assert.equal(latestInLine(a, 3, 11), '3.11.16');
  assert.equal(latestInLine(a, 3, 13), '3.13.2');
});

test('latestInLine 该线无版本时为 null', () => {
  assert.equal(latestInLine(JSON.parse(avail(['3.11.1'])), 3, 12), null);
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
