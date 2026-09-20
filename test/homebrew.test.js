import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInstalled, buildList, actionArgs, AdapterError } from '../server/adapters/homebrew.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'brew-installed.json'), 'utf8');
const items = parseInstalled(fixture);
const byId = (id) => items.find((i) => i.id === id);

test('formula 的当前版本取 linked_keg 而非清单中的最后一项', () => {
  assert.equal(byId('formula:openssl@3').current, '3.6.3');
  assert.equal(byId('formula:ca-certificates').current, '2026-08-13');
});

test('keg-only 包的 linked_keg 为 null 时回落到已装版本', () => {
  assert.equal(byId('formula:readline').current, '8.3.3');
});

test('formula 过时时 latest 为 stable 版本', () => {
  const i = byId('formula:openssl@3');
  assert.equal(i.status, 'outdated');
  assert.equal(i.latest, '3.6.4');
});

test('formula 最新时 latest 等于 current', () => {
  const i = byId('formula:ca-certificates');
  assert.equal(i.status, 'ok');
  assert.equal(i.latest, '2026-08-13');
});

test('cask 依已装版本与上游版本比较判定，不采信 outdated 字段', () => {
  const i = byId('cask:iterm2');
  assert.equal(i.current, '3.6.10');
  assert.equal(i.latest, '3.7.2');
  assert.equal(i.status, 'outdated');
});

test('cask 的显示名取 name 的首项', () => {
  assert.equal(byId('cask:iterm2').name, 'iTerm2');
  assert.equal(byId('cask:rectangle').name, 'Rectangle');
});

test('全部条目的 active 恒为 null', () => {
  assert.ok(items.every((i) => i.active === null));
});

test('全部条目具备更新与卸载两种操作', () => {
  assert.ok(items.every((i) => i.actions.length === 2 && i.actions.includes('update') && i.actions.includes('uninstall')));
});

test('formula 与 cask 的 ID 前缀不同', () => {
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('formula:openssl@3'));
  assert.ok(ids.includes('cask:iterm2'));
  assert.equal(new Set(ids).size, ids.length);
});

test('parseInstalled 对同名的 formula 与 cask 产生不同 ID', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'x', versions: { stable: '1' }, installed: [{ version: '1' }], linked_keg: '1', outdated: false }],
    casks: [{ token: 'x', name: ['X'], installed: '2', version: '2' }],
  });
  assert.deepEqual(parseInstalled(json).map((i) => i.id), ['formula:x', 'cask:x']);
});

test('parseInstalled 采用 full_name 以支持第三方 tap', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'node', full_name: 'someone/tap/node', versions: { stable: '2' }, installed: [{ version: '1' }], linked_keg: '1', outdated: true }],
  });
  const i = parseInstalled(json)[0];
  assert.equal(i.id, 'formula:someone/tap/node');
  assert.equal(i.name, 'someone/tap/node');
});

test('版本无法取得时状态为 unknown 且 latest 为 null', () => {
  const json = JSON.stringify({ casks: [{ token: 'broken', name: ['Broken'], installed: null, version: null }] });
  const i = parseInstalled(json)[0];
  assert.equal(i.status, 'unknown');
  assert.equal(i.latest, null);
});

test('parseInstalled 空对象返回空数组', () => {
  assert.deepEqual(parseInstalled('{}'), []);
});

test('parseInstalled 非 JSON 时抛出 AdapterError', () => {
  assert.throws(() => parseInstalled('not json'), (e) => e instanceof AdapterError && e.code === 'PARSE_FAILED');
});

test('actionArgs 生成带终止符的参数', () => {
  assert.deepEqual(actionArgs('upgrade', 'formula:node'), ['upgrade', '--formula', '--', 'node']);
  assert.deepEqual(actionArgs('uninstall', 'cask:iterm2'), ['uninstall', '--cask', '--', 'iterm2']);
});

test('actionArgs 拒绝无前缀的 ID', () => {
  assert.throws(() => actionArgs('upgrade', 'node'), (e) => e.code === 'BAD_ITEM_ID');
});

test('actionArgs 拒绝未知前缀', () => {
  assert.throws(() => actionArgs('upgrade', 'bogus:x'), (e) => e.code === 'BAD_ITEM_ID');
});

test('actionArgs 拒绝空的包名', () => {
  assert.throws(() => actionArgs('uninstall', 'formula:'), (e) => e.code === 'BAD_ITEM_ID');
});

test('actionArgs 拒绝非字符串的 ID', () => {
  assert.throws(() => actionArgs('uninstall', null), (e) => e.code === 'BAD_ITEM_ID');
  assert.throws(() => actionArgs('uninstall', undefined), (e) => e.code === 'BAD_ITEM_ID');
});

test('linked_keg 指向较旧版本时以它为当前版本', () => {
  const json = JSON.stringify({
    formulae: [{
      name: 'pinned', versions: { stable: '3.0' },
      installed: [{ version: '1.0' }, { version: '2.0' }],
      linked_keg: '1.0', outdated: true,
    }],
  });
  assert.equal(parseInstalled(json)[0].current, '1.0');
});

test('buildList 在命令失败时抛出而非返回空清单', () => {
  assert.throws(
    () => buildList({ info: { ok: false, exitCode: 1, stderr: 'brew 挂了', stdout: '', truncated: false } }),
    (e) => e instanceof AdapterError && e.code === 'LIST_FAILED'
  );
});

test('buildList 在输出被截断时抛出', () => {
  assert.throws(
    () => buildList({ info: { ok: true, exitCode: 0, stderr: '', stdout: '{}', truncated: true } }),
    (e) => e.code === 'LIST_TRUNCATED'
  );
});

test('buildList 正常时返回条目', () => {
  assert.deepEqual(buildList({ info: { ok: true, exitCode: 0, stderr: '', stdout: '{}', truncated: false } }), []);
});

test('formula 带中文简介', () => {
  assert.equal(byId('formula:openssl@3').description, '加密与 TLS 工具包');
});

test('词典中没有的包回落到英文原文', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'unknown-pkg', versions: { stable: '1' }, installed: [{ version: '1' }], linked_keg: '1', outdated: false, desc: 'Some English description' }],
  });
  assert.equal(parseInstalled(json)[0].description, 'Some English description');
});

test('既无词典也无英文原文时为 null', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'bare', versions: { stable: '1' }, installed: [{ version: '1' }], linked_keg: '1', outdated: false }],
  });
  assert.equal(parseInstalled(json)[0].description, null);
});

test('依赖包标记为非主动安装', () => {
  const json = JSON.stringify({
    formulae: [
      { name: 'dep', versions: { stable: '1' }, installed: [{ version: '1', installed_on_request: false }], linked_keg: '1', outdated: false },
      { name: 'mine', versions: { stable: '1' }, installed: [{ version: '1', installed_on_request: true }], linked_keg: '1', outdated: false },
    ],
  });
  const items = parseInstalled(json);
  assert.equal(items.find((i) => i.name === 'dep').requested, false);
  assert.equal(items.find((i) => i.name === 'mine').requested, true);
});

test('cask 恒为主动安装', () => {
  assert.equal(byId('cask:iterm2').requested, true);
});

test('installed_on_request 字段缺失时 requested 为 null 而非臆断', () => {
  const json = JSON.stringify({
    formulae: [{ name: 'nofield', versions: { stable: '1' }, installed: [{ version: '1' }], linked_keg: '1', outdated: false }],
  });
  assert.equal(parseInstalled(json)[0].requested, null);
});
