import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startWorkers, stopWorkers } from './queue.js';

const app = await buildApp();
await migrate((m) => app.log.info(m));
if (config.runWorkers) startWorkers((msg, extra) => app.log.info(extra ?? {}, msg));
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await stopWorkers();
    await pool.end();
    process.exit(0);
  });
}
