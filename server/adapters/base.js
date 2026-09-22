import { getConfig } from '../config.js';
import { run } from '../exec.js';

export class AdapterError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.detail = detail;
  }
}

export function listOpts() {
  const c = getConfig();
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.LIST_MAX_OUTPUT_BYTES };
}

export function actionOpts() {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.ACTION_MAX_OUTPUT_BYTES };
}

export function assertNotTruncated(result, what) {
  if (result.truncated) {
    throw new AdapterError(
      'LIST_TRUNCATED',
      `${what} 的输出超过 LIST_MAX_OUTPUT_BYTES 的上限，无法解析。请在 .env 中调大该项。`
    );
  }
}

export function assertOk(result, what) {
  if (!result.ok) {
    throw new AdapterError('LIST_FAILED', result.stderr.trim() || `${what} 以退出码 ${result.exitCode} 结束。`);
  }
}

const PROBE_TIMEOUT_MS = 10000;

// 探测类命令：取单行输出。失败一律降级为 null —— 位置取不到不应让整个生态消失。
export async function probeLine(command, args) {
  try {
    const r = await run(command, args, { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: 4096 });
    return r.ok ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}
