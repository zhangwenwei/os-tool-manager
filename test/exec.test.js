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
