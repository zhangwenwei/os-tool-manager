import { getConfig } from '../config.js';

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
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
}

export function actionOpts() {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
}

export function assertNotTruncated(result, what) {
  if (result.truncated) {
    throw new AdapterError(
      'LIST_TRUNCATED',
      `${what} 的输出超过 MAX_OUTPUT_BYTES 的上限，无法解析。请在 .env 中调大该项。`
    );
  }
}

export function assertOk(result, what) {
  if (!result.ok) {
    throw new AdapterError('LIST_FAILED', result.stderr.trim() || `${what} 以退出码 ${result.exitCode} 结束。`);
  }
}
