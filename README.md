# os-tool-manager

macOS 本地的工具管理面板。在浏览器中查看与管理 Homebrew 包、npm 全局包、pip 用户级包的清单、版本、更新与卸载。

## 启动

```bash
npm start
```

终端会打印含访问令牌的 URL，浏览器自动打开。无需 `npm install` —— 本项目零运行时依赖。

服务每次启动会生成新的访问令牌。重启后请使用终端中新打印的 URL。

## 要求

- macOS
- Node.js 22 以上

## 配置

全部配置项可省略。需要变更时将 `.env.example` 复制为 `.env` 后修改。

| 配置项 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `7788` | HTTP 服务端口 |
| `LIST_TIMEOUT_MS` | `60000` | 清单取得的子进程超时 |
| `ACTION_TIMEOUT_MS` | `600000` | 操作执行的子进程超时 |
| `LIST_MAX_OUTPUT_BYTES` | `16777216` | 清单取得的输出上限（JSON 解析预算） |
| `ACTION_MAX_OUTPUT_BYTES` | `1048576` | 操作执行的输出上限 |
| `AUTO_OPEN_BROWSER` | `true` | 启动时自动打开浏览器 |

无效的配置值会打印警告并退回默认值。

## 安全

本面板可执行卸载等破坏性操作，因此：

- 仅绑定 `127.0.0.1`，局域网内的其他机器无法访问
- `/api/*` 全部需要启动时生成的随机令牌
- POST 请求校验 `Origin`（只认 `127.0.0.1` 与 `localhost` 两个来源），阻止浏览中的其他网页调用本地服务
- 操作种类与操作对象均经白名单校验，命令参数以数组传递，不经由 shell
- 破坏性操作需要二次确认
- 不使用 `sudo`

## 测试

```bash
npm test
```

## 结构

```
server/
├── index.js       启动入口
├── config.js      配置读取
├── security.js    安全校验
├── routes.js      API 路由
├── static.js      静态资源
├── exec.js        子进程执行
└── adapters/      各生态的封装
web/               界面
```

新增一个生态只需在 `adapters/` 下加一个文件并注册，路由层与前端无需改动。

## 文档

- 要件定义书：`docs/specs/`
- 实装计划：`docs/plans/`
- 审查与验证记录：`docs/reviews/`
