import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';
import { generateToken } from './security.js';
import { createRouter, fail } from './routes.js';
import { createStatic } from './static.js';
import { adapters } from './adapters/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const config = getConfig();
const token = generateToken();
const baseUrl = `http://127.0.0.1:${config.PORT}`;
// localhost 是浏览器保留名，必定解析到回环地址；跨站攻击者的 Origin 会是其自身域名，
// 不会是 localhost。故同时允许这两者不削弱 SEC-07 的防护，而能避免使用者手输
// localhost 时所有操作都 403 却得不到解释。
const allowedOrigins = [baseUrl, `http://localhost:${config.PORT}`];

const handleApi = createRouter({ adapters, token, allowedOrigins });
const handleStatic = createStatic(join(root, 'web'));

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, baseUrl).pathname;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await handleStatic(req, res, pathname);
    }
  } catch (e) {
    if (res.headersSent) return;
    fail(res, 500, 'INTERNAL', '服务器内部错误。', e.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.PORT} 已被占用。`);
    console.error(`请在 .env 中设置 PORT=<其他端口> 后重新启动。`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

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
