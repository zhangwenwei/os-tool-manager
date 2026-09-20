import { run } from '../exec.js';
import { getConfig } from '../config.js';

const DETECT_TIMEOUT_MS = 5000;

const listOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};
const actionOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};

export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

function makeItem(id, name, current, latest) {
  const unknown = current == null || latest == null;
  return {
    id,
    name,
    current: current ?? null,
    latest: unknown ? null : latest,
    status: unknown ? 'unknown' : current === latest ? 'ok' : 'outdated',
    active: null,
    actions: ['update', 'uninstall'],
  };
}

function formulaItem(entry) {
  const name = entry.full_name ?? entry.name;
  const installed = (entry.installed ?? []).map((i) => i?.version).filter(Boolean);
  const current = entry.linked_keg ?? installed[installed.length - 1] ?? null;
  const latest = entry.outdated ? (entry.versions?.stable ?? null) : current;
  return makeItem(`formula:${name}`, name, current, latest);
}

function caskItem(entry) {
  const token = entry.token;
  return makeItem(`cask:${token}`, entry.name?.[0] ?? token, entry.installed ?? null, entry.version ?? null);
}

export function parseInstalled(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AdapterError('PARSE_FAILED', 'brew info 的输出不是合法 JSON。');
  }
  return [
    ...(data?.formulae ?? []).map(formulaItem),
    ...(data?.casks ?? []).map(caskItem),
  ];
}

export function commandArgs(subcommand, itemId) {
  if (typeof itemId !== 'string') {
    throw new AdapterError('BAD_ITEM_ID', `条目 ID 不是字符串：${itemId}`);
  }
  const sep = itemId.indexOf(':');
  const kind = sep === -1 ? '' : itemId.slice(0, sep);
  const name = sep === -1 ? '' : itemId.slice(sep + 1);
  if ((kind !== 'formula' && kind !== 'cask') || name === '') {
    throw new AdapterError('BAD_ITEM_ID', `无法识别的条目 ID：${itemId}`);
  }
  return [subcommand, `--${kind}`, '--', name];
}

export default {
  id: 'homebrew',
  label: 'Homebrew',

  async detect() {
    try {
      const r = await run('brew', ['--version'], { timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    const r = await run('brew', ['info', '--json=v2', '--installed'], listOpts());
    if (!r.ok) {
      throw new AdapterError('LIST_FAILED', r.stderr.trim() || `brew info 以退出码 ${r.exitCode} 结束。`);
    }
    if (r.truncated) {
      throw new AdapterError('LIST_TRUNCATED', 'brew info 的输出超过上限，无法解析。');
    }
    return parseInstalled(r.stdout);
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('brew', commandArgs('upgrade', item.id), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('brew', commandArgs('uninstall', item.id), actionOpts()),
    },
  },
};
