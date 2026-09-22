import { run } from '../exec.js';
import { AdapterError, listOpts, actionOpts, assertNotTruncated, assertOk, probeLine } from './base.js';
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
  // 类型检查不可省：pythonDir 为 [] 时 !pythonDir 为 false，而 startsWith([]) 恒为 true，
  // 会把系统 Python 一并放行。
  if (typeof pythonDir !== 'string' || pythonDir === '') return false;
  // 补上分隔符，避免 .../uv/python-evil 被当作 .../uv/python 的子路径。
  const prefix = pythonDir.endsWith('/') ? pythonDir : `${pythonDir}/`;
  return [entry?.path, entry?.symlink].some((p) => typeof p === 'string' && p.startsWith(prefix));
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

const IS_PRERELEASE = /[a-zA-Z]/;

// uv python upgrade 只在小版本线内升级，故最新版本取「同实现 + 同变体 + 同 major.minor」
// 内的最大补丁号。不得由 version_parts 拼字符串 —— 预发布版的 version 是 "3.15.0rc2"
// 而 patch 是 0，拼出的 "3.15.0" 在目录中并不存在，会使该条目永久显示有更新。
// 故返回候选条目真实的 version 字段。
export function latestInLine(available, entry) {
  const vp = entry?.version_parts ?? {};
  const candidates = available.filter(
    (e) =>
      e?.implementation === entry?.implementation
      && e?.variant === entry?.variant
      && e?.version_parts?.major === vp.major
      && e?.version_parts?.minor === vp.minor
      && Number.isInteger(e?.version_parts?.patch)
      && typeof e?.version === 'string'
  );
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) =>
      b.version_parts.patch - a.version_parts.patch
      || IS_PRERELEASE.test(a.version) - IS_PRERELEASE.test(b.version)
  );
  return candidates[0].version;
}

export function buildItems(installed, availableStdout) {
  // 可下载清单是辅助信息：解析不了就当作空，让 latest 为 null、状态为 unknown，
  // 而不是让整张卡片报错。已装清单才是主体，它的解析失败仍会抛出。
  let available = [];
  if (availableStdout !== null) {
    try {
      available = parseJson(availableStdout, 'uv python list');
    } catch {
      available = [];
    }
  }
  return installed
    .map((entry) => {
      const latest = latestInLine(available, entry);
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
    return probeLine('uv', ['python', 'dir']);
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
