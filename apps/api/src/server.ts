import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startWorkers, stopWorkers } from './queue.js';

const app = await buildApp();
await migrate((m) => app.log.info(m));
if (config.runWorkers) startWorkers((msg, extra) => app.log.info(extra ?? {}, msg));
await app.listen({ port: config.port, host: config.host });

// Test deployments: create the demo merchant and sample stores once, with a password from the environment.
if (process.env.SEED_DEMO_PASSWORD) {
  const { query } = await import('./db/pool.js');
  const exists = (await query(`SELECT 1 FROM users WHERE email = 'demo@sailes.dev'`)).rowCount;
  if (!exists) {
    const { seedDemo } = await import('./scripts/seed.js');
    seedDemo('demo@sailes.dev', process.env.SEED_DEMO_PASSWORD)
      .then((r) => app.log.info({ stores: r.stores.map((s) => s.key) }, 'demo stores seeded'))
      .catch((e) => app.log.error(e, 'demo seed failed'));
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await stopWorkers();
    await pool.end();
    process.exit(0);
  });
}
