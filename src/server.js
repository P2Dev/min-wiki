import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { acquireLock } from './store.js';

const directory = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const release = await acquireLock(directory);
let server;
try {
  const app = await createApp({ dataDir: directory });
  server = app.listen(port, host, () => console.log(`min wiki is ready at http://${host}:${port}`));
  server.on('error', async error => { console.error(error.message); await release(); process.exitCode = 1; });
} catch (error) { await release(); throw error; }
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await release(); process.exit(0); });
  server.closeIdleConnections();
});
