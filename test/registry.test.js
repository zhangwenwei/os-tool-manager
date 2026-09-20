import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapters } from '../server/adapters/registry.js';

test('注册表非空', () => {
  assert.ok(adapters.length > 0);
});

test('适配器 ID 唯一', () => {
  const ids = adapters.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const adapter of adapters) {
  test(`适配器 ${adapter.id} 满足要件书 7.1 节的接口形状`, () => {
    assert.equal(typeof adapter.id, 'string');
    assert.ok(adapter.id.length > 0);
    assert.equal(typeof adapter.label, 'string');
    assert.ok(adapter.label.length > 0);
    assert.equal(typeof adapter.detect, 'function');
    assert.equal(typeof adapter.list, 'function');
    assert.ok(adapter.actions && typeof adapter.actions === 'object');
    assert.ok(Object.keys(adapter.actions).length > 0);
    for (const [key, action] of Object.entries(adapter.actions)) {
      assert.equal(typeof action.label, 'string', `${adapter.id}.${key}.label 应为字符串`);
      assert.ok(action.label.length > 0, `${adapter.id}.${key}.label 不应为空`);
      assert.equal(typeof action.destructive, 'boolean', `${adapter.id}.${key}.destructive 应为布尔`);
      assert.equal(typeof action.run, 'function', `${adapter.id}.${key}.run 应为函数`);
    }
  });
}
