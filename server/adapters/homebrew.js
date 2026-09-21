import { run } from '../exec.js';
import { AdapterError, listOpts, actionOpts, assertNotTruncated, assertOk } from './base.js';
import { describe } from './descriptions.js';

const DETECT_TIMEOUT_MS = 5000;

function makeItem(id, name, current, latest, extra = {}) {
  const unknown = current == null || latest == null;
  return {
    id,
    name,
    current: current ?? null,
    latest: unknown ? null : latest,
    status: unknown ? 'unknown' : current === latest ? 'ok' : 'outdated',
    active: null,
    description: extra.description ?? null,
    requested: extra.requested ?? null,
    actions: ['update', 'uninstall'],
  };
}

function formulaItem(entry) {
  const name = entry.full_name ?? entry.name;
  const installed = (entry.installed ?? []).map((i) => i?.version).filter(Boolean);
  const current = entry.linked_keg ?? installed[installed.length - 1] ?? null;
  const latest = entry.outdated ? (entry.versions?.stable ?? null) : current;
  const id = `formula:${name}`;
  return makeItem(id, name, current, latest, {
    description: describe('homebrew', id, entry.desc),
    // installed_on_request 为 false 表示它是被其他包拖进来的依赖，单独卸载会弄坏依赖它的包。
    requested: entry.installed?.[0]?.installed_on_request ?? null,
  });
}

function caskItem(entry) {
  const token = entry.token;
  const id = `cask:${token}`;
  return makeItem(id, entry.name?.[0] ?? token, entry.installed ?? null, entry.version ?? null, {
    description: describe('homebrew', id, entry.desc),
    // cask 是独立应用，不存在被其他包依赖的情况。
    requested: true,
  });
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

// brew info 一条命令即可给出全部信息，两条守卫都适用标准规则。
export function buildList({ info }) {
  assertNotTruncated(info, 'brew info');
  assertOk(info, 'brew info');
  return parseInstalled(info.stdout);
}

export function actionArgs(subcommand, itemId) {
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

  async location() {
    try {
      const r = await run('brew', ['--prefix'], { timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 4096 });
      return r.ok ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  },

  async list() {
    return buildList({ info: await run('brew', ['info', '--json=v2', '--installed'], listOpts()) });
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('brew', actionArgs('upgrade', item.id), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('brew', actionArgs('uninstall', item.id), actionOpts()),
    },
  },
};

export { AdapterError };
