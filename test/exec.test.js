import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, truncate, ExecError } from '../server/exec.js';

const OPTS = { timeoutMs: 5000, maxBytes: 1048576 };

function pgrepCount(pattern) {
  return new Promise((resolve) => {
    const p = spawn('pgrep', ['-f', pattern]);
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', () => resolve(out.trim() === '' ? 0 : out.trim().split('\n').length));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('truncate 未超限时原样返回', () => {
  const r = truncate(Buffer.from('hello'), 100);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
});

test('truncate 恰好等于上限时不截断', () => {
  const r = truncate(Buffer.from('a'.repeat(20)), 20);
  assert.equal(r.truncated, false);
  assert.equal(r.text.length, 20);
});

test('truncate 超限时保留首尾并标示', () => {
  const r = truncate(Buffer.from('a'.repeat(50) + 'b'.repeat(50)), 20);
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('已省略'));
  const [head, , tail] = r.text.split('\n');
  assert.equal(head, 'a'.repeat(10));
  assert.equal(tail, 'b'.repeat(10));
});

test('truncate 的省略字节数准确', () => {
  const r = truncate(Buffer.from('a'.repeat(100)), 20);
  assert.match(r.text, /中间 80 字节已省略/);
});

test('truncate 不在多字节字符中间切断', () => {
  const r = truncate(Buffer.from('中'.repeat(100)), 100);
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes('�'), '不应出现替换字符');
});

test('run 正常结束时返回 ok 与 stdout', async () => {
  const r = await run('echo', ['hello'], OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stdout.trim(), 'hello');
  assert.equal(r.truncated, false);
});

test('run 非零退出码时 ok 为 false 但不抛出', async () => {
  const r = await run('sh', ['-c', 'echo oops >&2; exit 3'], OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr.trim(), 'oops');
});

test('run 同时收集 stdout 与 stderr', async () => {
  const r = await run('sh', ['-c', 'echo to-out; echo to-err >&2'], OPTS);
  assert.equal(r.stdout.trim(), 'to-out');
  assert.equal(r.stderr.trim(), 'to-err');
});

test('run 参数以数组传递，不经由 shell 展开（SEC-11）', async () => {
  const r = await run('echo', ['$HOME; rm -rf /tmp/nonexistent'], OPTS);
  assert.equal(r.stdout.trim(), '$HOME; rm -rf /tmp/nonexistent');
});

test('run 超时时抛出 TIMEOUT', async () => {
  await assert.rejects(
    () => run('sleep', ['5'], { timeoutMs: 100, maxBytes: 1024 }),
    (e) => e instanceof ExecError && e.code === 'TIMEOUT'
  );
});

test('run 超时后子进程确实被终止（要件书 9.2）', async () => {
  const marker = `otm-kill-${process.pid}-${Date.now()}`;
  await assert.rejects(
    () => run('sh', ['-c', `sleep 30; echo ${marker}`], { timeoutMs: 200, maxBytes: 1024 }),
    (e) => e.code === 'TIMEOUT'
  );
  await sleep(400);
  assert.equal(await pgrepCount(marker), 0, '子进程应已被终止');
});

test('run 孙进程持有管道时仍能超时结算（NFR-07/08）', async () => {
  const marker = `otm-grand-${process.pid}-${Date.now()}`;
  const started = Date.now();
  await assert.rejects(
    () => run('sh', ['-c', `sh -c 'sleep 30; echo ${marker}' & wait`], { timeoutMs: 250, maxBytes: 1024 }),
    (e) => e.code === 'TIMEOUT'
  );
  assert.ok(Date.now() - started < 3000, '不应等待孙进程自然结束');
  await sleep(400);
  assert.equal(await pgrepCount(marker), 0, '孙进程应随进程组一并终止');
});

test('run 命令不存在时抛出 ENOENT', async () => {
  await assert.rejects(
    () => run('definitely-not-a-real-command-xyz', [], OPTS),
    (e) => e instanceof ExecError && e.code === 'ENOENT'
  );
});

test('run 权限不足时报 EACCES 而非 ENOENT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otm-'));
  const script = join(dir, 'noexec.sh');
  writeFileSync(script, '#!/bin/sh\necho x\n');
  chmodSync(script, 0o644);
  await assert.rejects(
    () => run(script, [], OPTS),
    (e) => e instanceof ExecError && e.code === 'EACCES'
  );
});

test('run 缺少 options 时 reject 而非同步抛出', async () => {
  await assert.rejects(
    () => run('echo', ['hi']),
    (e) => e instanceof ExecError && e.code === 'BAD_OPTIONS'
  );
});

test('run 的 timeoutMs 非正整数时 reject', async () => {
  await assert.rejects(
    () => run('echo', ['hi'], { timeoutMs: -1, maxBytes: 1024 }),
    (e) => e.code === 'BAD_OPTIONS'
  );
});

test('run 的 maxBytes 非正整数时 reject', async () => {
  await assert.rejects(
    () => run('echo', ['hi'], { timeoutMs: 1000, maxBytes: 0 }),
    (e) => e.code === 'BAD_OPTIONS'
  );
});

test('run 输出超限时标示 truncated', async () => {
  const r = await run('sh', ['-c', 'printf "x%.0s" $(seq 1 500)'], { timeoutMs: 5000, maxBytes: 100 });
  assert.equal(r.truncated, true);
});

test('run 大量输出时保持输出长度有界（流式截断）', async () => {
  const r = await run(
    'sh',
    ['-c', 'dd if=/dev/zero bs=1024 count=8192 2>/dev/null | tr "\\0" "x"'],
    { timeoutMs: 30000, maxBytes: 1024 }
  );
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 2048, `stdout 应被限制在上限附近，实际 ${r.stdout.length}`);
  // 8388608 字节总输出 - 保留的 head 512 + tail 512 = 8387584
  assert.match(r.stdout, /中间 8387584 字节已省略/);
});

test('run 被信号终止时记录 signal', async () => {
  const r = await run('sh', ['-c', 'kill -TERM $$'], OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.equal(r.signal, 'SIGTERM');
});
