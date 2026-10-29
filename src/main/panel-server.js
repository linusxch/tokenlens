'use strict';

/**
 * 面板服务：把同一套 UI 以 HTTP 形式暴露出去，方便嵌进 harness 的 web 面板
 * 或任意 iframe（「外置插件」形态之一）。只监听回环地址，不对外网开放。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function startPanelServer(service, options = {}) {
  const root = options.root || path.join(__dirname, '..', 'renderer');
  const port = options.port || 4317;
  const host = options.host || '127.0.0.1';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);

    if (url.pathname === '/api/snapshot') {
      try {
        const payload = service.snapshot({
          sessionId: url.searchParams.get('session') || undefined,
          source: url.searchParams.get('source')
            || (url.searchParams.get('demo') === '1' ? 'demo' : undefined),
        });
        const body = JSON.stringify(payload);
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
      }
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/index.html' });
      res.end();
      return;
    }

    // 静态文件：限制在 renderer 目录内
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = path.join(root, rel);
    const normalized = path.normalize(full);
    if (!normalized.startsWith(path.normalize(root))) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(normalized, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(normalized).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        url: `http://${host}:${port}/index.html`,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { startPanelServer };
