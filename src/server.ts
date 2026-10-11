import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './api.js';
import { openDatabase, seedOrigins } from './db.js';
import { AttributionService } from './service.js';

const path = process.env.DB_PATH ?? 'data/attribution.sqlite';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválida');
const db = openDatabase(path);
seedOrigins(db);
const app = createApp(new AttributionService(db));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => {
  console.log(`API em http://127.0.0.1:${info.port}; SQLite: ${path}`);
});
function shutdown() {
  server.close(() => { db.close(); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
