import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGlobalList, parseOutdated, buildItems, buildList, actionArgs, AdapterError, LIST_ARGS } from '../server/adapters/npm.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');
const lsOut = read('npm-ls.json');
const outdatedOut = read('npm-outdated.json');

const ok = (stdout, exitCode = 0) => ({ ok: exitCode === 0, exitCode, stdout, stderr: '', truncated: false });

test('parseGlobalList 解析真实输出', () => {
  assert.deepEqual(parseGlobalList(lsOut), [
    { name: '@deepseek-ai/dsh', current: '0.1.1-rc.2', description: 'dsh CLI: profile boot, plugin management, and the browser UI alias' },
    { name: '@fission-ai/openspec', current: '1.10.0', description: 'AI-native system for spec-driven development' },
  ]);
});

test('parseGlobalList 无依赖时返回空数组', () => {
  assert.deepEqual(parseGlobalList('{}'), []);
});

test('parseGlobalList 跳过缺少 version 的项', () => {
  assert.deepEqual(parseGlobalList('{"dependencies":{"broken":{},"ok":{"version":"1.0.0"}}}'), [
    { name: 'ok', current: '1.0.0', description: null },
  ]);
});

test('parseGlobalList 非 JSON 时抛出', () => {
  assert.throws(() => parseGlobalList('npm ERR!'), (e) => e instanceof AdapterError);
});

test('parseOutdated 解析真实输出', () => {
  const m = parseOutdated(outdatedOut);
  assert.equal(m.get('@deepseek-ai/dsh'), '0.1.5-rc.2');
  assert.equal(m.get('@fission-ai/openspec'), '1.13.1');
});

test('parseOutdated 空输出返回空 Map', () => {
  assert.equal(parseOutdated('').size, 0);
  assert.equal(parseOutdated('   ').size, 0);
});

test('parseOutdated 非 JSON 时抛出', () => {
  assert.throws(() => parseOutdated('npm ERR!'), (e) => e instanceof AdapterError);
});

test('parseOutdated 在表中但缺 latest 时记为 null', () => {
  assert.equal(parseOutdated('{"x":{"current":"1.0.0"}}').get('x'), null);
});

test('buildItems 过时时状态为 outdated', () => {
  const items = buildItems([{ name: 'tsx', current: '4.0.0' }], new Map([['tsx', '4.1.0']]));
  assert.equal(items[0].id, 'tsx');
  assert.equal(items[0].status, 'outdated');
  assert.equal(items[0].latest, '4.1.0');
  assert.equal(items[0].active, null);
  assert.deepEqual(items[0].actions, ['update', 'uninstall']);
});

test('buildItems 不在过时表中时状态为 ok', () => {
  const items = buildItems([{ name: 'tsx', current: '4.0.0' }], new Map());
  assert.equal(items[0].status, 'ok');
  assert.equal(items[0].latest, '4.0.0');
});

test('buildItems 在过时表中但 latest 为 null 时状态为 unknown', () => {
  const items = buildItems([{ name: 'tsx', current: '4.0.0' }], new Map([['tsx', null]]));
  assert.equal(items[0].status, 'unknown');
  assert.equal(items[0].latest, null);
});

test('buildItems 对 npm 自身不提供卸载', () => {
  assert.deepEqual(buildItems([{ name: 'npm', current: '11.12.1' }], new Map())[0].actions, ['update']);
});

test('buildList 组合真实输出', () => {
  const items = buildList({ list: ok(lsOut), outdated: ok(outdatedOut, 1) });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.status === 'outdated'));
});

test('buildList 接受 npm outdated 的退出码 1', () => {
  assert.doesNotThrow(() => buildList({ list: ok(lsOut), outdated: ok(outdatedOut, 1) }));
});

test('buildList 拒绝 npm outdated 的其他非零退出码', () => {
  assert.throws(
    () => buildList({ list: ok(lsOut), outdated: { ok: false, exitCode: 127, stdout: '', stderr: 'not found', truncated: false } }),
    (e) => e.code === 'OUTDATED_FAILED'
  );
});

test('buildList 在 npm ls 失败且无输出时抛出', () => {
  assert.throws(
    () => buildList({ list: { ok: false, exitCode: 1, stdout: '', stderr: '炸了', truncated: false }, outdated: ok('{}') }),
    (e) => e.code === 'LIST_FAILED'
  );
});

test('buildList 在 npm ls 退出码非零但有输出时仍解析', () => {
  const items = buildList({ list: ok(lsOut, 1), outdated: ok('{}') });
  assert.equal(items.length, 2);
});

test('buildList 在输出被截断时抛出', () => {
  assert.throws(
    () => buildList({ list: { ok: true, exitCode: 0, stdout: '{}', stderr: '', truncated: true }, outdated: ok('{}') }),
    (e) => e.code === 'LIST_TRUNCATED'
  );
});

test('actionArgs 生成全局安装与卸载参数', () => {
  assert.deepEqual(actionArgs('install', 'tsx', '@latest'), ['install', '-g', 'tsx@latest']);
  assert.deepEqual(actionArgs('uninstall', '@scope/pkg'), ['uninstall', '-g', '@scope/pkg']);
});

test('actionArgs 拒绝以连字符或点开头的包名', () => {
  assert.throws(() => actionArgs('uninstall', '-rf'), (e) => e.code === 'BAD_ITEM_ID');
  assert.throws(() => actionArgs('uninstall', '../evil'), (e) => e.code === 'BAD_ITEM_ID');
});

test('actionArgs 拒绝空名与非字符串', () => {
  assert.throws(() => actionArgs('uninstall', ''), (e) => e.code === 'BAD_ITEM_ID');
  assert.throws(() => actionArgs('uninstall', null), (e) => e.code === 'BAD_ITEM_ID');
});

test('npm 包带中文简介', () => {
  const items = buildItems([{ name: '@deepseek-ai/dsh', current: '1' }], new Map());
  assert.equal(items[0].description, 'DeepSeek 的命令行工具');
});

test('npm 包全部标记为主动安装', () => {
  const items = buildItems([{ name: 'tsx', current: '1' }], new Map());
  assert.equal(items[0].requested, true);
});

test('取得清单的命令带 --long，否则拿不到 description', () => {
  assert.ok(LIST_ARGS.includes('--long'));
});

test('词典未收录时回落到 npm 给出的英文说明', () => {
  const items = buildItems([{ name: 'unknown-pkg', current: '1', description: 'Some English text' }], new Map());
  assert.equal(items[0].description, 'Some English text');
});
