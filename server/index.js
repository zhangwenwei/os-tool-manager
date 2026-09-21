import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';
import { generateToken } from './security.js';
import { createRouter } from './routes.js';
import { createStatic } from './static.js';
import { createRequestHandler, handleServerError } from './app.js';
import { adapters } from './adapters/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const config = getConfig();
const token = generateToken();
const baseUrl = `http://127.0.0.1:${config.PORT}`;
// Origin 由浏览器按发起文档的源填写，而源由 scheme / host / port 三者决定。
// 跨站攻击者的文档源是其自身域名，无法取得源为 http://localhost:<PORT> 的文档；
// DNS rebinding 也不行 —— 即使 evil.com 重绑至回环地址，文档的源仍是 http://evil.com。
// 攻击者若在本机自跑服务，其端口必然不同，而端口精确参与比较。故同时允许这两者
// 不削弱 SEC-07 的防护，而能避免使用者手输 localhost 时所有操作都 403 却得不到解释。
//
// 本项防护成立的前提是比较为精确字符串相等。任何退化为子串匹配或前缀匹配的实装
// 都会直接推翻上述论证，故 checkOrigin 须校验白名单为数组。
const allowedOrigins = [baseUrl, `http://localhost:${config.PORT}`];

const server = createServer(
  createRequestHandler({
    handleApi: createRouter({ adapters, token, allowedOrigins }),
    handleStatic: createStatic(join(root, 'web')),
    baseUrl,
  })
);

server.on('error', (err) => handleServerError(err, config.PORT));

server.listen(config.PORT, '127.0.0.1', () => {
  const url = `${baseUrl}/?token=${token}`;
  console.log('os-tool-manager 已启动');
  console.log(url);
  if (config.AUTO_OPEN_BROWSER) {
    const opener = spawn('open', [url], { stdio: 'ignore', detached: true });
    opener.on('error', () => {});
    opener.unref();
  }
});
