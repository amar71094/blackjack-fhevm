const http = require('http');
const { getHandHistory, listTableIds, MAX_HANDS_PER_TABLE, loadStore } = require('./handHistoryStore');

const DEFAULT_PORT = Number(process.env.ORACLE_ACTIVITY_PORT ?? 4001);
const DEFAULT_HOST = process.env.ORACLE_ACTIVITY_HOST ?? '127.0.0.1';
const CORS_ORIGIN = process.env.ORACLE_ACTIVITY_CORS_ORIGIN ?? '*';

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function parseTableId(pathname) {
  const match = pathname.match(/^\/tables\/(\d+)\/activity\/?$/);
  if (!match) return null;
  const tableId = Number(match[1]);
  return Number.isFinite(tableId) && tableId > 0 ? tableId : null;
}

function createActivityServer() {
  return http.createServer((req, res) => {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const { pathname, searchParams } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (pathname === '/health') {
      const store = loadStore();
      sendJson(res, 200, {
        ok: true,
        contract: store.contract || null,
        tables: listTableIds().length,
        maxHandsPerTable: MAX_HANDS_PER_TABLE
      });
      return;
    }

    const tableId = parseTableId(pathname);
    if (tableId !== null) {
      const limit = Number(searchParams.get('limit') ?? MAX_HANDS_PER_TABLE);
      const activity = getHandHistory(tableId, limit);
      sendJson(res, 200, {
        tableId,
        limit: Math.min(Math.max(1, limit || MAX_HANDS_PER_TABLE), MAX_HANDS_PER_TABLE),
        activity
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

function startActivityServer(options = {}) {
  const enabled = options.enabled ?? process.env.ORACLE_ACTIVITY_ENABLED !== 'false';
  if (!enabled) {
    return null;
  }

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = createActivityServer();

  server.listen(port, host, () => {
    console.log(`[activity] listening on http://${host}:${port}`);
    console.log(`[activity] GET /tables/:id/activity  (max ${MAX_HANDS_PER_TABLE} hands)`);
  });

  server.on('error', (err) => {
    console.error('[activity] server error:', err.message ?? err);
  });

  return server;
}

module.exports = { startActivityServer, createActivityServer, DEFAULT_PORT };