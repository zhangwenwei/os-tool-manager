import { spawn } from 'node:child_process';

// 进程组被终止后，等待 close 事件的宽限时间
const KILL_GRACE_MS = 300;

export class ExecError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.detail = detail;
  }
}

// 丢弃开头处被切断的 UTF-8 继续字节
function alignStart(buf) {
  let i = 0;
  while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

// 丢弃末尾处不完整的 UTF-8 字符
function alignEnd(buf) {
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
  if (end > 0) {
    const lead = buf[end - 1];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (buf.length - (end - 1) < need) return buf.subarray(0, end - 1);
  }
  return buf;
}

// 流式收集输出。超过上限后只保留首尾各 half 字节，内存不随输出总量增长
export function createCollector(maxBytes) {
  const half = Math.floor(maxBytes / 2);
  let chunks = [];
  let total = 0;
  let overflowed = false;
  let head = null;
  let tail = Buffer.alloc(0);

  return {
    push(chunk) {
      total += chunk.length;
      if (!overflowed) {
        chunks.push(chunk);
        if (total > maxBytes) {
          const all = Buffer.concat(chunks);
          head = all.subarray(0, half);
          tail = all.subarray(all.length - half);
          chunks = null;
          overflowed = true;
        }
        return;
      }
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > half) tail = tail.subarray(tail.length - half);
    },
    result() {
      if (!overflowed) {
        return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
      }
      const omitted = total - head.length - tail.length;
      const headText = alignEnd(head).toString('utf8');
      const tailText = alignStart(tail).toString('utf8');
      return {
        text: `${headText}\n…（中间 ${omitted} 字节已省略）…\n${tailText}`,
        truncated: true,
      };
    },
  };
}

export function truncate(buf, maxBytes) {
  const collector = createCollector(maxBytes);
  collector.push(buf);
  return collector.result();
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已终止 */ }
  }
}

export function run(command, args, options = {}) {
  const { timeoutMs, maxBytes } = options;
  return new Promise((resolve, reject) => {
    for (const [name, value] of [['timeoutMs', timeoutMs], ['maxBytes', maxBytes]]) {
      if (!Number.isInteger(value) || value <= 0) {
        reject(new ExecError('BAD_OPTIONS', `${name} 必须为正整数，实际为 ${value}`));
        return;
      }
    }

    let child;
    try {
      child = spawn(command, args, { shell: false, detached: true });
    } catch (err) {
      reject(new ExecError(err.code ?? 'SPAWN_FAILED', `命令执行失败：${command}`, err.message));
      return;
    }

    const out = createCollector(maxBytes);
    const err = createCollector(maxBytes);
    let timedOut = false;
    let settled = false;
    let graceTimer = null;

    const timeoutError = () =>
      new ExecError('TIMEOUT', `命令超时（${timeoutMs}ms）：${command}`);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      fn(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      // 孙进程仍持有管道时 close 不会到来，宽限后强制结算
      graceTimer = setTimeout(() => finish(reject, timeoutError()), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.on('error', (e) => {
      finish(reject, new ExecError(e.code ?? 'SPAWN_FAILED', `命令执行失败：${command}`, e.message));
    });

    child.on('close', (exitCode, signal) => {
      if (timedOut) {
        finish(reject, timeoutError());
        return;
      }
      const stdout = out.result();
      const stderr = err.result();
      finish(resolve, {
        ok: exitCode === 0,
        exitCode,
        signal: signal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}
