import { spawn } from 'node:child_process';

export class ExecError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.detail = detail;
  }
}

export function truncate(buf, maxBytes) {
  if (buf.length <= maxBytes) {
    return { text: buf.toString('utf8'), truncated: false };
  }
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.length - half).toString('utf8');
  const omitted = buf.length - half * 2;
  return {
    text: `${head}\n…（中间 ${omitted} 字节已省略）…\n${tail}`,
    truncated: true,
  };
}

export function run(command, args, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));

    child.on('error', (err) => {
      finish(reject, new ExecError('ENOENT', `命令执行失败：${command}`, err.message));
    });

    child.on('close', (exitCode) => {
      if (timedOut) {
        finish(reject, new ExecError('TIMEOUT', `命令超时（${timeoutMs}ms）：${command}`));
        return;
      }
      const out = truncate(Buffer.concat(outChunks), maxBytes);
      const err = truncate(Buffer.concat(errChunks), maxBytes);
      finish(resolve, {
        ok: exitCode === 0,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}
