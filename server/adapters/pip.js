import { run } from '../exec.js';
import { getConfig } from '../config.js';

const DETECT_TIMEOUT_MS = 10000;

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

function parseJsonArray(stdout, what) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AdapterError('PARSE_FAILED', `${what} 的输出不是合法 JSON。`);
  }
  if (!Array.isArray(data)) {
    throw new AdapterError('PARSE_FAILED', `${what} 的输出不是数组。`);
  }
  return data;
}

export function parseList(stdout) {
  return parseJsonArray(stdout, 'pip list')
    .filter((e) => e?.name && e?.version)
    .map((e) => ({ name: e.name, current: e.version }));
}

export function parseOutdated(stdout) {
  const map = new Map();
  for (const e of parseJsonArray(stdout, 'pip list --outdated')) {
    if (e?.name) map.set(e.name, e.latest_version ?? null);
  }
  return map;
}

export function buildItems(packages, outdated) {
  return [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg) => {
      const hasEntry = outdated.has(pkg.name);
      const latest = hasEntry ? outdated.get(pkg.name) : pkg.current;
      const unknown = latest == null;
      return {
        id: pkg.name,
        name: pkg.name,
        current: pkg.current,
        latest: unknown ? null : latest,
        status: unknown ? 'unknown' : latest === pkg.current ? 'ok' : 'outdated',
        active: null,
        actions: ['update', 'uninstall'],
      };
    });
}

export function buildList(listResult, outdatedResult) {
  if (listResult.truncated || outdatedResult.truncated) {
    throw new AdapterError('LIST_TRUNCATED', 'pip 的输出超过上限，无法解析。');
  }
  if (!listResult.ok) {
    throw new AdapterError('LIST_FAILED', listResult.stderr.trim() || `pip list 以退出码 ${listResult.exitCode} 结束。`);
  }
  if (!outdatedResult.ok) {
    throw new AdapterError('OUTDATED_FAILED', outdatedResult.stderr.trim() || `pip list --outdated 以退出码 ${outdatedResult.exitCode} 结束。`);
  }
  return buildItems(parseList(listResult.stdout), parseOutdated(outdatedResult.stdout));
}

export function packageArgs(subcommand, name, extra = []) {
  if (typeof name !== 'string' || name === '' || name.startsWith('-')) {
    throw new AdapterError('BAD_ITEM_ID', `无法识别的包名：${name}`);
  }
  return ['-m', 'pip', subcommand, ...extra, name];
}

export default {
  id: 'pip',
  label: 'pip 用户级包',

  async detect() {
    try {
      const r = await run('python3', ['-m', 'pip', '--version'], { timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    const [listResult, outdatedResult] = await Promise.all([
      run('python3', ['-m', 'pip', 'list', '--user', '--format=json'], listOpts()),
      run('python3', ['-m', 'pip', 'list', '--user', '--outdated', '--format=json'], listOpts()),
    ]);
    return buildList(listResult, outdatedResult);
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('python3', packageArgs('install', item.id, ['--user', '--upgrade']), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('python3', packageArgs('uninstall', item.id, ['-y']), actionOpts()),
    },
  },
};
