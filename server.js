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

// Global resilience handlers to prevent unexpected process crashes
process.on('uncaughtException', (err) => {
  console.error('⚠️ [Server] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Server] Unhandled Rejection at:', promise, 'reason:', reason);
});


// ─── REALTIME SERVER-SENT EVENTS (SSE) HUB ───
const sseClients = new Set();

function broadcastRealtime(eventData, excludeClientId = null) {
  const message = `data: ${JSON.stringify(eventData)}\n\n`;
  for (const client of sseClients) {
    if (excludeClientId && client.id === excludeClientId) continue;
    try {
      client.res.write(message);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// 20-second heartbeat to maintain persistent SSE connections
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(': heartbeat\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 20000);

function startServer(port, callback) {
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

    // ─── REALTIME SSE STREAM & BROADCAST ROUTES ───
    if (reqUrl === '/api/realtime/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      const clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      const clientObj = { id: clientId, res };
      sseClients.add(clientObj);

      res.write(`data: ${JSON.stringify({ type: 'CONNECTED', clientId, clientsCount: sseClients.size, timestamp: Date.now() })}\n\n`);

      // Inform other peers of new connection
      broadcastRealtime({ type: 'PEER_JOINED', clientId, clientsCount: sseClients.size, timestamp: Date.now() }, clientId);

      req.on('close', () => {
        sseClients.delete(clientObj);
        broadcastRealtime({ type: 'PEER_LEFT', clientId, clientsCount: sseClients.size, timestamp: Date.now() });
      });
      return;
    }

    if (reqUrl === '/api/realtime/broadcast' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const senderId = payload.senderId || null;
          broadcastRealtime({ ...payload, timestamp: Date.now() }, senderId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, clientsCount: sseClients.size }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (reqUrl === '/api/realtime/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, clientsCount: sseClients.size }));
      return;
    }

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

    if (reqUrl === '/api/debug/db-status' && req.method === 'GET') {
      const https = require('https');
      const supaFetch = (table) => new Promise((resolve) => {
        const options = {
          hostname: 'rakklmxpukcehbyjuxjy.supabase.co',
          path: `/rest/v1/${table}?select=*`,
          method: 'GET',
          headers: {
            'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc',
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJha2tsbXhwdWtjZWhieWp1eGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY0MjgsImV4cCI6MjA5Mzc0MjQyOH0.05GCQVOXhH1CGWjgQkpu9mMKipT4wcPht4u3nf6c8Rc'
          }
        };
        const r = https.request(options, (sRes) => {
          let d = '';
          sRes.on('data', c => d += c);
          sRes.on('end', () => {
            try { resolve({ status: sRes.statusCode, data: JSON.parse(d) }); }
            catch (e) { resolve({ status: sRes.statusCode, raw: d }); }
          });
        });
        r.on('error', err => resolve({ error: err.message }));
        r.end();
      });

      Promise.all([
        supaFetch('organizations'),
        supaFetch('users'),
        supaFetch('categories'),
        supaFetch('products')
      ]).then(([orgs, users, cats, prods]) => {
        console.log('[DEBUG DB STATUS]:', {
          orgsCount: Array.isArray(orgs.data) ? orgs.data.length : orgs,
          usersCount: Array.isArray(users.data) ? users.data.length : users,
          catsCount: Array.isArray(cats.data) ? cats.data.length : cats,
          prodsCount: Array.isArray(prods.data) ? prods.data.length : prods
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          organizations: orgs,
          users: users,
          categories: cats,
          products: prods
        }, null, 2));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // ─── STATIC FILE SERVING ───
    let relativePath = reqUrl === '/' ? 'index.html' : reqUrl.replace(/^\/+/, '');
    let filePath = path.join(__dirname, relativePath);

    // Prevent directory traversal
    const normalizedBase = path.resolve(__dirname);
    const normalizedTarget = path.resolve(filePath);
    if (!normalizedTarget.startsWith(normalizedBase)) {
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
      startServer(port + 1, callback);
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
    if (callback) callback(port, server);
  });

  return server;
}

if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = { startServer, DEFAULT_PORT };
