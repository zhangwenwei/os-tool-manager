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

export function parseGlobalList(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AdapterError('PARSE_FAILED', 'npm ls 的输出不是合法 JSON。');
  }
  return Object.entries(data?.dependencies ?? {})
    .filter(([, v]) => v?.version)
    .map(([name, v]) => ({ name, current: v.version }));
}

export function parseOutdated(stdout) {
  if (!stdout.trim()) return new Map();
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AdapterError('PARSE_FAILED', 'npm outdated 的输出不是合法 JSON。');
  }
  const map = new Map();
  for (const [name, info] of Object.entries(data ?? {})) {
    map.set(name, info?.latest ?? null);
  }
  return map;
}

export function buildItems(packages, outdated) {
  return packages.map((pkg) => {
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
      actions: pkg.name === 'npm' ? ['update'] : ['update', 'uninstall'],
    };
  });
}

export function buildList(listResult, outdatedResult) {
  if (listResult.truncated || outdatedResult.truncated) {
    throw new AdapterError('LIST_TRUNCATED', 'npm 的输出超过上限，无法解析。');
  }
  if (!listResult.ok && !listResult.stdout.trim()) {
    throw new AdapterError('LIST_FAILED', listResult.stderr.trim() || `npm ls 以退出码 ${listResult.exitCode} 结束。`);
  }
  if (outdatedResult.exitCode !== 0 && outdatedResult.exitCode !== 1) {
    throw new AdapterError('OUTDATED_FAILED', outdatedResult.stderr.trim() || `npm outdated 以退出码 ${outdatedResult.exitCode} 结束。`);
  }
  return buildItems(parseGlobalList(listResult.stdout), parseOutdated(outdatedResult.stdout));
}

export function packageArgs(subcommand, name, suffix = '') {
  if (typeof name !== 'string' || name === '' || name.startsWith('-') || name.startsWith('.')) {
    throw new AdapterError('BAD_ITEM_ID', `无法识别的包名：${name}`);
  }
  return [subcommand, '-g', `${name}${suffix}`];
}

export default {
  id: 'npm',
  label: 'npm 全局包',

  async detect() {
    try {
      const r = await run('npm', ['--version'], { timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    const [listResult, outdatedResult] = await Promise.all([
      run('npm', ['ls', '-g', '--depth=0', '--json'], listOpts()),
      run('npm', ['outdated', '-g', '--json'], listOpts()),
    ]);
    return buildList(listResult, outdatedResult);
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('npm', packageArgs('install', item.id, '@latest'), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('npm', packageArgs('uninstall', item.id), actionOpts()),
    },
  },
};
