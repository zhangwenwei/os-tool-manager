import { run } from '../exec.js';
import { AdapterError, listOpts, actionOpts, assertNotTruncated, assertOk } from './base.js';

const DETECT_TIMEOUT_MS = 10000;

function parseJsonArray(stdout, what) {
  // 与 npm 适配器对齐：命令成功但输出为空时视为空集合。
  if (!stdout.trim()) return [];
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
        description: null,
        // pip list --user 包含传递依赖，无法从中判别是否主动安装（需 --not-required）。
        // 按要件书 7.2 节，无法判别时为 null，界面不显示「依赖」标签也不做相反的断言。
        requested: null,
        actions: ['update', 'uninstall'],
      };
    });
}

// pip 的两条命令在正常情况下退出码均为 0，适用标准守卫。
export function buildList({ list, outdated }) {
  assertNotTruncated(list, 'pip list');
  assertNotTruncated(outdated, 'pip list --outdated');
  assertOk(list, 'pip list');
  assertOk(outdated, 'pip list --outdated');
  return buildItems(parseList(list.stdout), parseOutdated(outdated.stdout));
}

export function actionArgs(subcommand, name, extra = []) {
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
    const [list, outdated] = await Promise.all([
      run('python3', ['-m', 'pip', 'list', '--user', '--format=json'], listOpts()),
      run('python3', ['-m', 'pip', 'list', '--user', '--outdated', '--format=json'], listOpts()),
    ]);
    return buildList({ list, outdated });
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('python3', actionArgs('install', item.id, ['--user', '--upgrade']), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('python3', actionArgs('uninstall', item.id, ['-y']), actionOpts()),
    },
  },
};

export { AdapterError };
