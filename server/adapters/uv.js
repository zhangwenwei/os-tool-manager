import { run } from '../exec.js';
import { AdapterError, listOpts, actionOpts, assertNotTruncated, assertOk } from './base.js';
import { describe } from './descriptions.js';

const DETECT_TIMEOUT_MS = 10000;
// uv 的 key 形如 cpython-3.11.16-macos-x86_64-none：含下划线。
// 首字符必须是字母或数字 —— 否则 --force 这类选项会被当作条目 ID 放行。
const VERSION_KEY = /^[0-9a-z][0-9a-z._+-]*$/;

function parseJson(stdout, what) {
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

function isManagedBy(entry, pythonDir) {
  if (!pythonDir) return false;
  return [entry?.path, entry?.symlink].some((p) => typeof p === 'string' && p.startsWith(pythonDir));
}

// 同一个 Python 会有多条记录（符号链接与真实路径各一条），按 key 去重。
// 系统 Python 也在输出中，必须按安装目录排除 —— 否则会对它提供卸载按钮。
export function parseInstalled(stdout, pythonDir) {
  const byKey = new Map();
  for (const entry of parseJson(stdout, 'uv python list')) {
    if (!entry?.key || !entry?.version) continue;
    if (!isManagedBy(entry, pythonDir)) continue;
    const existing = byKey.get(entry.key);
    // 保留带符号链接的那条：它说明该版本在 ~/.local/bin 下有入口，即当前生效
    if (!existing || (!existing.symlink && entry.symlink)) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

// uv python upgrade 只在小版本线内升级，故最新版本取同 major.minor 的最大值。
export function latestInLine(available, major, minor) {
  const same = available
    .filter((e) => e?.version_parts?.major === major && e?.version_parts?.minor === minor)
    .map((e) => e.version_parts.patch)
    .filter((p) => Number.isInteger(p));
  return same.length ? `${major}.${minor}.${Math.max(...same)}` : null;
}

export function buildItems(installed, availableStdout) {
  const available = availableStdout === null ? [] : parseJson(availableStdout, 'uv python list');
  return installed
    .map((entry) => {
      const { major, minor } = entry.version_parts ?? {};
      const latest = Number.isInteger(major) && Number.isInteger(minor)
        ? latestInLine(available, major, minor)
        : null;
      const current = entry.version;
      const unknown = latest == null;
      const name = `${entry.implementation ?? 'python'} ${current}`;
      return {
        id: entry.key,
        name,
        current,
        latest: unknown ? null : latest,
        status: unknown ? 'unknown' : current === latest ? 'ok' : 'outdated',
        // uv 为某个版本在 ~/.local/bin 下建符号链接，该版本即当前生效（FR-08）
        active: Boolean(entry.symlink),
        description: describe('uv', entry.key, `由 uv 管理的 ${entry.implementation ?? 'python'} ${current}`),
        requested: true,
        actions: ['update', 'uninstall'],
      };
    })
    .sort((a, b) => a.current.localeCompare(b.current, undefined, { numeric: true }));
}

export function buildList({ installed, available, pythonDir }) {
  assertNotTruncated(installed, 'uv python list --only-installed');
  assertOk(installed, 'uv python list --only-installed');
  // 可下载版本的查询失败不致命：拿不到就让 latest 为 null、状态为 unknown，
  // 而不是让整张卡片报错。已装清单才是主体。
  const availableStdout = available.ok && !available.truncated ? available.stdout : null;
  return buildItems(parseInstalled(installed.stdout, pythonDir), availableStdout);
}

export function actionArgs(subcommand, key) {
  if (typeof key !== 'string' || !VERSION_KEY.test(key)) {
    throw new AdapterError('BAD_ITEM_ID', `无法识别的 Python 标识：${key}`);
  }
  return ['python', subcommand, key];
}

export default {
  id: 'uv',
  label: 'uv 的 Python',

  async detect() {
    try {
      const r = await run('uv', ['--version'], { timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 4096 });
      return r.ok;
    } catch {
      return false;
    }
  },

  async location() {
    try {
      const r = await run('uv', ['python', 'dir'], { timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 4096 });
      return r.ok ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  },

  async list() {
    const pythonDir = await this.location();
    if (!pythonDir) {
      throw new AdapterError('LIST_FAILED', '无法取得 uv 的 Python 安装目录。');
    }
    const [installed, available] = await Promise.all([
      run('uv', ['python', 'list', '--only-installed', '--output-format', 'json'], listOpts()),
      run('uv', ['python', 'list', '--output-format', 'json'], listOpts()),
    ]);
    return buildList({ installed, available, pythonDir });
  },

  actions: {
    update: {
      label: '更新',
      destructive: false,
      run: (item) => run('uv', actionArgs('upgrade', item.id), actionOpts()),
    },
    uninstall: {
      label: '卸载',
      destructive: true,
      run: (item) => run('uv', actionArgs('uninstall', item.id), actionOpts()),
    },
  },
};
