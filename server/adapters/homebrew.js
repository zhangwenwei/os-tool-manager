import { run, ExecError } from '../exec.js';
import { getConfig } from '../config.js';

const listOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.LIST_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};
const actionOpts = () => {
  const c = getConfig();
  return { timeoutMs: c.ACTION_TIMEOUT_MS, maxBytes: c.MAX_OUTPUT_BYTES };
};

export function parseVersions(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    out.push({ name: parts[0], current: parts[parts.length - 1] });
  }
  return out;
}

export function parseOutdated(stdout) {
  const map = new Map();
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return map;
  }
  for (const [key, prefix] of [['formulae', 'formula'], ['casks', 'cask']]) {
    for (const entry of data?.[key] ?? []) {
      if (entry?.name) map.set(`${prefix}:${entry.name}`, entry.current_version ?? null);
    }
  }
  return map;
}

export function buildItems(formulae, casks, outdated) {
  const build = (prefix) => (pkg) => {
    const id = `${prefix}:${pkg.name}`;
    const latest = outdated.get(id);
    return {
      id,
      name: pkg.name,
      current: pkg.current,
      latest: latest ?? pkg.current,
      status: latest ? 'outdated' : 'ok',
      active: null,
      actions: ['update', 'uninstall'],
    };
  };
  return [...formulae.map(build('formula')), ...casks.map(build('cask'))];
}

export function commandArgs(subcommand, itemId) {
  const sep = itemId.indexOf(':');
  const kind = itemId.slice(0, sep);
  const name = itemId.slice(sep + 1);
  if (kind !== 'formula' && kind !== 'cask') {
    throw new ExecError('BAD_ITEM_ID', `无法识别的条目 ID：${itemId}`);
  }
  return [subcommand, `--${kind}`, name];
}

export default {
  id: 'homebrew',
  label: 'Homebrew',

  async detect() {
    try {
      const r = await run('brew', ['--version'], { timeoutMs: 5000, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async list() {
    const [formulaOut, caskOut, outdatedOut] = await Promise.all([
      run('brew', ['list', '--formula', '--versions'], listOpts()),
      run('brew', ['list', '--cask', '--versions'], listOpts()),
      run('brew', ['outdated', '--json=v2'], listOpts()),
    ]);
    return buildItems(
      parseVersions(formulaOut.stdout),
      parseVersions(caskOut.stdout),
      parseOutdated(outdatedOut.stdout)
    );
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
