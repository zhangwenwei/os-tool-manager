import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseList, parseOutdated, buildItems, buildList, actionArgs, AdapterError } from '../server/adapters/pip.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');
const listOut = read('pip-list.json');
const outdatedOut = read('pip-outdated.json');

const ok = (stdout) => ({ ok: true, exitCode: 0, stdout, stderr: '', truncated: false });

test('parseList 解析名称与版本', () => {
  const r = parseList(listOut);
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { name: 'numpy', current: '1.26.4' });
});

test('parseList 空数组返回空数组', () => {
  assert.deepEqual(parseList('[]'), []);
});

test('parseList 跳过缺少字段的项', () => {
  assert.deepEqual(parseList('[{"name":"x"},{"version":"1"},{"name":"ok","version":"1"}]'), [
    { name: 'ok', current: '1' },
  ]);
});

test('parseList 非 JSON 时抛出', () => {
  assert.throws(() => parseList('ERROR: something'), (e) => e instanceof AdapterError && e.code === 'PARSE_FAILED');
});

test('parseList 非数组时抛出', () => {
  assert.throws(() => parseList('{"a":1}'), (e) => e.code === 'PARSE_FAILED');
});

test('parseOutdated 解析最新版本', () => {
  const m = parseOutdated(outdatedOut);
  assert.equal(m.get('numpy'), '2.4.1');
  assert.equal(m.get('requests'), '2.33.0');
  assert.equal(m.size, 2);
});

test('parseOutdated 在表中但缺 latest_version 时记为 null', () => {
  assert.equal(parseOutdated('[{"name":"x","version":"1"}]').get('x'), null);
});

test('parseOutdated 非 JSON 时抛出', () => {
  assert.throws(() => parseOutdated('ERROR'), (e) => e.code === 'PARSE_FAILED');
});

test('buildItems 过时时状态为 outdated', () => {
  const items = buildItems([{ name: 'numpy', current: '1.26.4' }], new Map([['numpy', '2.4.1']]));
  assert.equal(items[0].id, 'numpy');
  assert.equal(items[0].status, 'outdated');
  assert.equal(items[0].latest, '2.4.1');
  assert.equal(items[0].active, null);
  assert.deepEqual(items[0].actions, ['update', 'uninstall']);
});

test('buildItems 不在过时表中时状态为 ok', () => {
  const items = buildItems([{ name: 'numpy', current: '1.26.4' }], new Map());
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].latest, '1.26.4');
});

test('buildItems 在过时表中但版本为 null 时状态为 unknown', () => {
  const items = buildItems([{ name: 'numpy', current: '1.26.4' }], new Map([['numpy', null]]));
  assert.equal(items[0].status, 'unknown');
  assert.equal(items[0].latest, null);
});

test('buildItems 按名称排序', () => {
  const items = buildItems(
    [{ name: 'zstandard', current: '1' }, { name: 'attrs', current: '2' }, { name: 'numpy', current: '3' }],
    new Map()
  );
  assert.deepEqual(items.map((i) => i.name), ['attrs', 'numpy', 'zstandard']);
});

test('buildItems 不修改传入的数组', () => {
  const input = [{ name: 'z', current: '1' }, { name: 'a', current: '2' }];
  buildItems(input, new Map());
  assert.equal(input[0].name, 'z');
});

test('buildList 组合真实输出', () => {
  const items = buildList({ list: ok(listOut), outdated: ok(outdatedOut) });
  assert.equal(items.length, 4);
  assert.equal(items.filter((i) => i.status === 'outdated').length, 2);
  assert.equal(items.filter((i) => i.status === 'ok').length, 2);
});

test('buildList 在空清单时返回空数组', () => {
  assert.deepEqual(buildList({ list: ok('[]'), outdated: ok('[]') }), []);
});

test('buildList 在 pip list 失败时抛出', () => {
  assert.throws(
    () => buildList({ list: { ok: false, exitCode: 1, stdout: '', stderr: '炸了', truncated: false }, outdated: ok('[]') }),
    (e) => e.code === 'LIST_FAILED'
  );
});

test('buildList 在 pip outdated 失败时抛出 LIST_FAILED', () => {
  assert.throws(
    () => buildList({ list: ok('[]'), outdated: { ok: false, exitCode: 1, stdout: '', stderr: '网络不通', truncated: false } }),
    (e) => e.code === 'LIST_FAILED'
  );
});

test('buildList 在输出被截断时抛出', () => {
  assert.throws(
    () => buildList({ list: { ok: true, exitCode: 0, stdout: '[]', stderr: '', truncated: true }, outdated: ok('[]') }),
    (e) => e.code === 'LIST_TRUNCATED'
  );
});

test('actionArgs 生成更新与卸载参数', () => {
  assert.deepEqual(actionArgs('install', 'numpy', ['--user', '--upgrade']), [
    '-m', 'pip', 'install', '--user', '--upgrade', 'numpy',
  ]);
  assert.deepEqual(actionArgs('uninstall', 'numpy', ['-y']), ['-m', 'pip', 'uninstall', '-y', 'numpy']);
});

test('actionArgs 拒绝以连字符开头的包名', () => {
  assert.throws(() => actionArgs('uninstall', '-rf', ['-y']), (e) => e.code === 'BAD_ITEM_ID');
});

test('actionArgs 拒绝空名与非字符串', () => {
  assert.throws(() => actionArgs('uninstall', '', ['-y']), (e) => e.code === 'BAD_ITEM_ID');
  assert.throws(() => actionArgs('uninstall', null, ['-y']), (e) => e.code === 'BAD_ITEM_ID');
});
