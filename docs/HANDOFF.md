# 交接文档（2026-09-22）

接手前**必读 `CLAUDE.md`**（开发规矩：新功能先定要件、每次变更必须独立评审、测试必须能杀死变异、禁止 `pkill`）。

## 一、当前状态

| 项 | 状态 |
|---|---|
| 分支 | `main`，工作区干净 |
| 测试 | `npm test` → 241 全通过 |
| 远程 | https://github.com/zhangwenwei/os-tool-manager （Public）。**本地领先 1 笔**：`docs: 要件书 v3.3`，需 `git push` |
| 适配器 | homebrew（`/usr/local`）、npm（`~/.local`）、uv 的 Python（`~/.local/share/uv/python`） |
| 要件书 | `docs/specs/2026-09-20-os-tool-manager-requirements.md` v3.3，59 条 |
| 使用者的服务 | 可能在终端运行中（端口 7788）。验证请用 `PORT=7799` 的临时 `.env`，按 PID 精确终止，结束后删除 `.env` |

已删除：Docker 适配器（使用者不需要）、pip 适配器（本机恒 0 件，换成 uv）。

## 二、进行中：孤儿依赖功能（要件已定，**实装未开始**）

要件书 v3.3 §3.5 的 FR-27～FR-30 与 SEC-14，以及 §7.1（`cardActions`）、§7.2（`orphan`、`uninstallImpact`）、§7.5（两个新端点）。

### 需求

1. **FR-27** 条目标示「孤儿」—— 取自 `brew autoremove --dry-run`
2. **FR-28** 卸载确认框预告「预计会留下这些孤儿」—— 自行推算，标为预计，**不参与任何删除决定**
3. **FR-29/30** 卡片级「清理孤儿」按钮，确认框列出将删除的全部包
4. **SEC-14** 执行前路由层调用 `preview()` 重取清单，与使用者确认的清单比对，一致才调用 `run()`（跑 `brew autoremove`）。比对须在 `busy` 锁内。执行后 `listedItems.delete(adapter.id)`

### 已验证的事实（读过 brew 源码 `utils/autoremove.rb`、`cleanup.rb`）

- **dry-run 输出格式**：`==> Would autoremove N unneeded formula(e):` 后跟 N 行包名。无孤儿时什么都不打印
- **陷阱 1**：brew 把提示信息（`Disable this behaviour...`、`Hide these hints...`）打到 **stdout**。只能取 header 声明的 N 行，且每行须为合法包名，否则抛 `PARSE_FAILED`
- **陷阱 2**：孤儿须**迭代到不动点**。模拟卸载 node：单轮只得 14 个，不动点 23 个（漏 `openssl@3`、`ca-certificates` 等 9 个）
- **陷阱 3**：brew 判定含 6 个条件（不动点、`installed_on_request` 缺失时不删、源码编译保留、cask 依赖保留、tap 名归一化、`HOMEBREW_NO_CLEANUP_FORMULAE`）。故删除对象必须以 brew 的 dry-run 为准
- 本机真实数据验证：现状 0 孤儿（与 brew 一致）；卸 node→23、htop→1（ncurses）、gh→0
- dry-run 耗时约 1～1.8 秒，与 `brew info` 并发执行即可

### 已验证的核心代码（放进 `server/adapters/homebrew.js`）

```js
const AUTOREMOVE_HEADER = /^==> Would autoremove (\d+) unneeded formulae?:$/;
const FORMULA_NAME = /^[a-z0-9][a-z0-9@+._/-]*$/;
const ANSI = /\x1b\[[0-9;]*m/g;

export function parseAutoremoveDryRun(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.replace(ANSI, '').trimEnd());
  const at = lines.findIndex((l) => AUTOREMOVE_HEADER.test(l));
  if (at === -1) return [];
  const count = Number(AUTOREMOVE_HEADER.exec(lines[at])[1]);
  const names = lines.slice(at + 1, at + 1 + count);
  if (names.length !== count || names.some((n) => !FORMULA_NAME.test(n))) {
    throw new AdapterError('PARSE_FAILED', 'brew autoremove --dry-run 的输出无法解析。');
  }
  return names;
}

const baseName = (name) => String(name).split('/').pop();

// 仅用于 FR-28 预告，不参与删除决定
export function computeRemovable(formulae, caskDeps) {
  let remaining = formulae;
  const removed = [];
  for (;;) {
    const keep = new Set(caskDeps.map(baseName));
    for (const f of remaining) {
      const tab = f?.installed?.[0];
      for (const dep of tab?.runtime_dependencies ?? []) if (dep?.full_name) keep.add(baseName(dep.full_name));
      if (tab && tab.poured_from_bottle === false) keep.add(f.name);
    }
    const round = remaining.filter((f) => {
      const tab = f?.installed?.[0];
      return !keep.has(f.name) && tab && tab.installed_on_request === false; // 严格相等：缺失不算
    });
    if (!round.length) return removed;
    removed.push(...round.map((f) => f.full_name ?? f.name));
    const gone = new Set(round.map((f) => f.name));
    remaining = remaining.filter((f) => !gone.has(f.name));
  }
}

export function computeImpact(formulae, caskDeps, targetName) {
  const before = new Set(computeRemovable(formulae, caskDeps));
  const after = computeRemovable(formulae.filter((f) => (f.full_name ?? f.name) !== targetName), caskDeps);
  return after.filter((n) => !before.has(n)).sort();
}
```

`caskDeps = data.casks.flatMap((c) => c?.depends_on?.formula ?? [])`。

### 实装要点

- `list()` 并发跑 `brew info --json=v2 --installed` 与 `brew autoremove --dry-run`；dry-run 失败时**降级为不标孤儿**（辅助信息）
- `cardActions.autoremove.preview()` **不降级** —— 它决定删除对象，解析失败必须抛出
- npm、uv 的条目加 `orphan: null, uninstallImpact: null`，不声明 `cardActions`
- `security.js` 新增 `checkCardAction`（`Object.hasOwn`）与 `checkConfirmedList`（须 `Array.isArray`、元素 `typeof === 'string'`、拒绝重复、顺序无关比较）。**本项目已三次栽在「校验函数缺类型契约」上**
- 路由新增 `GET /api/adapters/:id/card-actions/:action/preview` 与 `POST /api/adapters/:id/card-actions/:action`（请求体 `{ confirmed, confirm: true }`），套用 token / Origin / 白名单 / 确认标记 / `busy` 全部关卡
- 前端：「孤儿」标签、卡片级按钮、卸载确认框追加预告（`#confirm-text { white-space: pre-wrap }`）。**只用 `textContent`**
- `test/registry.test.js` 的破坏性约定表加 `autoremove: true`，并遍历 `cardActions`
- 测试固件 `test/fixtures/brew-autoremove-dry-run.txt` 依源码格式构造（本机无孤儿无法实测），并混入 stdout 提示行

### 完成后

1. 变异验证（至少覆盖：去掉 count 限制、去掉包名校验、只跑一轮、`=== false` 改 `!`、去掉 SEC-14 比对、去掉 `listedItems.delete`、`destructive` 改 false）
2. **独立评审**（规格 + 质量），按 CLAUDE.md 不可省略
3. 实机只读验证：**只能调用 `preview()`，绝不调用 `run()`**
4. 同步 README 的功能表与测试件数

## 三、之后的待办

1. **多机场景验证**（项目的原始动机，至今只在这台 Intel Mac 上跑过）。在另一台 Mac `git clone` 后 `npm start`。若是 Apple Silicon，正好验证 NFR-12（brew 前缀 `/opt/homebrew`）
2. 端口占用提示不说明「可能是另一个实例在跑」，使用者踩过四次。建议打出 `kill $(lsof -t -iTCP:7788 -sTCP:LISTEN)`（改 NFR-14，按流程先改要件）
3. 仓库没有 LICENSE（许可证「未定」），Public 仓库默认保留所有权利
4. uv tool（OUT-11）：`uv tool list` 无 JSON 输出且本机无工具，待使用者真装了工具再做

## 四、已知的环境事实

- Intel x86_64，brew 前缀 `/usr/local`，Node v25.9.0
- `node --test test/`（目录参数）在 Node 25 上失败，测试脚本用 glob `'test/**/*.js'`
- `uv` 在 `~/.local/bin`，可能不在默认 PATH，实机验证需 `PATH="$HOME/.local/bin:$PATH"`
- 使用者主动安装的 brew 包只有 `gh`、`htop`、`node`（ffmpeg 已卸，并已 `brew autoremove`）
- 使用者曾经卸载 iTerm2（配置保留在 `~/Library/Application Support/iTerm2`）
