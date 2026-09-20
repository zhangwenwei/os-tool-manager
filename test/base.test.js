import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOpts, actionOpts, assertNotTruncated, assertOk, AdapterError } from '../server/adapters/base.js';
import { DEFAULTS } from '../server/config.js';

test('listOpts 使用清单的超时与输出预算', () => {
  const o = listOpts();
  assert.equal(o.timeoutMs, DEFAULTS.LIST_TIMEOUT_MS);
  assert.equal(o.maxBytes, DEFAULTS.LIST_MAX_OUTPUT_BYTES);
});

test('actionOpts 使用操作的超时与输出预算', () => {
  const o = actionOpts();
  assert.equal(o.timeoutMs, DEFAULTS.ACTION_TIMEOUT_MS);
  assert.equal(o.maxBytes, DEFAULTS.ACTION_MAX_OUTPUT_BYTES);
});

test('两者的预算互不相同，不会被写混', () => {
  assert.notEqual(listOpts().maxBytes, actionOpts().maxBytes);
  assert.notEqual(listOpts().timeoutMs, actionOpts().timeoutMs);
});

test('assertNotTruncated 在截断时抛出并指名配置项', () => {
  assert.throws(
    () => assertNotTruncated({ truncated: true }, '某命令'),
    (e) => e instanceof AdapterError && e.code === 'LIST_TRUNCATED' && e.message.includes('LIST_MAX_OUTPUT_BYTES')
  );
});

test('assertNotTruncated 未截断时通过', () => {
  assert.equal(assertNotTruncated({ truncated: false }, '某命令'), undefined);
});

test('assertOk 在失败时抛出并带上 stderr', () => {
  assert.throws(
    () => assertOk({ ok: false, exitCode: 2, stderr: '出错了' }, '某命令'),
    (e) => e.code === 'LIST_FAILED' && e.message.includes('出错了')
  );
});

test('assertOk 在 stderr 为空时退回退出码', () => {
  assert.throws(
    () => assertOk({ ok: false, exitCode: 2, stderr: '' }, '某命令'),
    (e) => e.message.includes('2')
  );
});
