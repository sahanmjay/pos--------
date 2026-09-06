const http = require('http');
const fs = require('fs');
const path = require('path');
const { getQueue } = require('./ramis-queue');

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// Initialize RAMIS Background Queue
const ramisQueue = getQueue();

function startServer(port) {
  const server = http.createServer((req, res) => {
    // CORS Headers for API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = req.url.split('?')[0];

    // ─── RAMIS BACKGROUND QUEUE API ROUTES ───
    if (reqUrl === '/api/ramis/enqueue' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          // Enqueue asynchronously without blocking the client checkout
          const result = await ramisQueue.enqueue(payload);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (reqUrl === '/api/ramis/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const stats = ramisQueue.getStats ? ramisQueue.getStats() : { status: 'active' };
      res.end(JSON.stringify({ success: true, stats }));
      return;
    }

    if (reqUrl === '/api/ramis/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const config = ramisQueue.ramisService ? ramisQueue.ramisService.getConfig() : {};
      res.end(JSON.stringify({ success: true, config }));
      return;
    }

    if (reqUrl === '/api/ramis/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const newCfg = JSON.parse(body || '{}');
          const updated = ramisQueue.ramisService ? ramisQueue.ramisService.updateConfig(newCfg) : {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, config: updated }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (reqUrl === '/api/ramis/test-auth' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const result = await ramisQueue.ramisService.testAuth(payload);
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    // ─── STATIC FILE SERVING ───
    let relativePath = reqUrl === '/' ? 'index.html' : reqUrl.replace(/^\/+/, '');
    let filePath = path.join(__dirname, relativePath);

    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      fs.createReadStream(filePath).pipe(res);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(port, () => {
    console.log(`\n==============================================`);
    console.log(`🚀 NexPOS SaaS Platform is live!`);
    console.log(`   ➜ Local:   http://localhost:${port}/`);
    console.log(`   ➜ RAMIS:   http://localhost:${port}/api/ramis/status`);
    console.log(`==============================================\n`);
  });
}

startServer(DEFAULT_PORT);
