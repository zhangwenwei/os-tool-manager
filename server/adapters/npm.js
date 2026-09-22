import { run } from '../exec.js';
import { AdapterError, listOpts, actionOpts, assertNotTruncated, probeLine } from './base.js';
import { describe } from './descriptions.js';

const DETECT_TIMEOUT_MS = 10000;

// --long 是取得 description 的必要条件（FR-24）。
export const LIST_ARGS = ['ls', '-g', '--depth=0', '--json', '--long'];

export function parseGlobalList(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AdapterError('PARSE_FAILED', 'npm ls 的输出不是合法 JSON。');
  }
  return Object.entries(data?.dependencies ?? {})
    .filter(([, v]) => v?.version)
    .map(([name, v]) => ({ name, current: v.version, description: v.description ?? null }));
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
      description: describe('npm', pkg.name, pkg.description ?? null),
      requested: true,
      actions: pkg.name === 'npm' ? ['update'] : ['update', 'uninstall'],
    };
  });
}

export function buildList({ list, outdated }) {
  assertNotTruncated(list, 'npm ls');
  assertNotTruncated(outdated, 'npm outdated');

  // npm ls -g 在存在 peer 依赖缺失、extraneous 包等情况时退出码非零，
  // 但 stdout 仍是完整可用的 JSON。故只在「失败且无输出」时才判定为失败，
  // 不能用 base.js 的 assertOk。
  if (!list.ok && !list.stdout.trim()) {
    throw new AdapterError('LIST_FAILED', list.stderr.trim() || `npm ls 以退出码 ${list.exitCode} 结束。`);
  }

  // npm outdated 在存在过时包时退出码为 1，这是正常结果而非失败。
  // 本机实测：两个全局包均过时，退出码为 1，stdout 为完整 JSON。
  if (outdated.exitCode !== 0 && outdated.exitCode !== 1) {
    throw new AdapterError(
      'OUTDATED_FAILED',
      outdated.stderr.trim() || `npm outdated 以退出码 ${outdated.exitCode} 结束。`
    );
  }

  return buildItems(parseGlobalList(list.stdout), parseOutdated(outdated.stdout));
}

export function actionArgs(subcommand, name, suffix = '') {
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

  async location() {
    return probeLine('npm', ['prefix', '-g']);
  },

  async list() {
    const [list, outdated] = await Promise.all([
      run('npm', LIST_ARGS, listOpts()),
      run('npm', ['outdated', '-g', '--json'], listOpts()),
    ]);
    return buildList({ list, outdated });
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('npm', actionArgs('install', item.id, '@latest'), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('npm', actionArgs('uninstall', item.id), actionOpts()),
    },
  },
};

export { AdapterError };
