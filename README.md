# os-tool-manager

macOS 上的本地工具管理面板。在浏览器里查看和管理 Homebrew 包、npm 全局包、pip 用户级包 —— 装了什么、版本多少、哪些该更新，以及一键更新和卸载。

零运行时依赖：只用 Node.js 标准库和原生前端，`git clone` 完不需要 `npm install` 就能跑。

## 为什么做它

在多台 Mac 上工作时，各台机器装的工具和版本总是对不上。想知道「这台到底装了什么」就得敲一串命令，记不住包名、看不清哪些过时了。这个面板把这些收拢到一个页面。

## 快速开始

```bash
git clone <仓库地址>
cd os-tool-manager
npm start
```

终端会打印一个带访问令牌的 URL，浏览器自动打开。就这样，没有安装步骤。

> 服务每次启动生成新令牌。重启后要用终端里新打印的 URL。

## 要求

- macOS
- Node.js 22 以上

不需要的东西：任何 npm 依赖、数据库、配置文件、账号。

## 功能

按生态分卡片显示，各卡片独立加载 —— Homebrew 查询慢的时候不会阻塞其他卡片。

| 生态 | 管理对象 | 操作 |
|---|---|---|
| Homebrew | formula 与 cask | 更新、卸载 |
| npm | 全局安装的包 | 更新、卸载 |
| pip | 系统 Python 的 `--user` 包 | 更新、卸载 |

未安装的生态不会显示，不视为错误 —— 多台机器环境本就不一致。

## 安全

这个面板能执行卸载，所以安全边界是硬要求，不是可选项：

- **只绑定 `127.0.0.1`** —— 同一局域网内的其他机器访问不到。咖啡厅 WiFi 上不会有人扫到它
- **`/api/*` 全部需要访问令牌** —— 启动时随机生成，前端从 URL 读入后立刻用 `history.replaceState` 从地址栏抹掉，不留在浏览器历史里
- **POST 校验 `Origin`** —— 只认 `127.0.0.1` 与 `localhost` 两个来源。这挡的是你浏览其他网页时，恶意页面偷偷向本地服务发请求（同源策略挡不住这种写请求）
- **命令注入的三重防线** —— 操作种类白名单、操作对象白名单、参数以数组传递不经由 shell
- **破坏性操作需要二次确认**
- **不使用 `sudo`**，也不提供任何提权入口

子进程超时会终止**整个进程组**，而不只是直接子进程 —— 否则 `brew upgrade` 派生的编译进程会继续持有管道，导致请求永久挂起。

## 配置

全部可省略。需要时把 `.env.example` 复制为 `.env` 再改。

| 配置项 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `7788` | HTTP 服务端口 |
| `LIST_TIMEOUT_MS` | `60000` | 清单取得的子进程超时 |
| `ACTION_TIMEOUT_MS` | `600000` | 操作执行的子进程超时 |
| `LIST_MAX_OUTPUT_BYTES` | `16777216` | 清单取得的输出上限（JSON 解析预算） |
| `ACTION_MAX_OUTPUT_BYTES` | `1048576` | 操作执行的输出上限 |
| `AUTO_OPEN_BROWSER` | `true` | 启动时自动打开浏览器 |

无效的值会打印警告并退回默认值，不会静默生效。

## 架构

```
server/
├── index.js       启动接线
├── app.js         请求分发与启动错误处理
├── config.js      配置读取与校验
├── security.js    令牌、Origin、白名单校验
├── routes.js      API 路由与排他控制
├── static.js      静态资源
├── exec.js        子进程执行：超时、截断、数组传参
└── adapters/
    ├── base.js    适配器共通基础
    ├── registry.js
    ├── homebrew.js
    ├── npm.js
    └── pip.js
web/               界面（原生 HTML/CSS/JS）
```

核心是适配器模式。`routes.js` 与 `web/app.js` 里不出现任何具体生态的名称，只依赖统一接口。

### 加一个新生态

新增一个适配器文件并在 `registry.js` 注册即可，路由层与前端都不用动：

```js
export default {
  id: 'docker',
  label: 'Docker 容器',
  detect: async () => { /* 本机是否可用 */ },
  list: async () => { /* → Item[] */ },
  actions: {
    restart: { label: '重启', destructive: false, run: (item) => { /* ... */ } },
    remove:  { label: '删除', destructive: true,  run: (item) => { /* ... */ } },
  },
};
```

`test/registry.test.js` 是契约测试，接口形状写错会在测试阶段就暴露，而不是等到运行时。

适配器必须把「执行命令」和「解析输出」分开，解析部分实现为纯函数 —— 这样测试不依赖本机实际装了什么。

## 测试

```bash
npm test
```

219 个测试，用 Node 内置的 `node:test`。覆盖解析函数、安全校验、子进程执行、路由契约与错误分流。真正会改变系统的命令不做自动测试，以手动验证替代（见 `docs/reviews/`）。

## 文档

这个项目是按 要件定义 → 实装计划 → 实装 的顺序做的，过程记录都在：

| 目录 | 内容 |
|---|---|
| `docs/specs/` | 要件定义书（EARS 记法，53 条要件） |
| `docs/plans/` | 实装计划 |
| `docs/reviews/` | 一致性审查报告、手动验证记录 |

## 已知的限制

- 只在 Intel Mac 上验证过。Apple Silicon 理论上可用（不硬编码 brew 路径），但未实测
- `brew outdated` 默认跳过带 `auto_updates` 的 cask，本项目改用已装版本与上游版本直接比较来绕开
- pip 适配器只管 `--user` 范围的包，不碰系统级包

## 许可证

未定。
