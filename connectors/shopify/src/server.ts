import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({ config });

// Periodic full resync ("nightly"): check every 15 minutes for shops whose last sync is older than RESYNC_HOURS.
const timer = setInterval(() => {
  app.connector.resyncDue().catch((e) => app.log.error(e, 'resync check failed'));
}, 15 * 60_000);
timer.unref();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    clearInterval(timer);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
