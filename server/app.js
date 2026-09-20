import { fail } from './routes.js';

export function createRequestHandler({ handleApi, handleStatic, baseUrl }) {
  return async function handleRequest(req, res) {
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
  };
}

export function handleServerError(err, port, io = {}) {
  const log = io.error ?? console.error;
  const exit = io.exit ?? process.exit;
  if (err.code === 'EADDRINUSE') {
    log(`端口 ${port} 已被占用。`);
    log(`请在 .env 中设置 PORT=<其他端口> 后重新启动。`);
  } else {
    log(err);
  }
  exit(1);
}
