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
