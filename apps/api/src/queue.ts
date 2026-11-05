import { Queue, Worker } from 'bullmq';
import { config } from './config.js';
import { providerForTenant } from './ai/registry.js';
import { embedPendingProducts } from './catalog/service.js';

/**
 * Background jobs. Catalog rows are written synchronously (fast batch upserts); embedding,
 * which calls the AI provider, runs here so a 50,000-SKU import never times out.
 */
const QUEUE = 'catalog-embeddings';
const connection = { url: config.redisUrl, maxRetriesPerRequest: null };

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function runEmbeddingJob(tenantId: string) {
  const { provider } = await providerForTenant(tenantId);
  return embedPendingProducts(tenantId, provider);
}

export async function enqueueEmbedding(tenantId: string) {
  if (config.inlineJobs) {
    await runEmbeddingJob(tenantId);
    return;
  }
  queue ??= new Queue(QUEUE, { connection });
  // One pending job per tenant is enough: it embeds everything still missing a vector.
  await queue.add('embed', { tenantId }, { jobId: `embed-${tenantId}-${Math.floor(Date.now() / 5000)}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 });
}

export function startWorkers(log: (msg: string, extra?: unknown) => void) {
  if (config.inlineJobs || worker) return;
  worker = new Worker(
    QUEUE,
    async (job) => {
      const n = await runEmbeddingJob(job.data.tenantId);
      log(`embedded ${n} products`, { tenantId: job.data.tenantId });
      return n;
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => log(`embedding job failed: ${err.message}`, { tenantId: job?.data?.tenantId }));
}

export async function stopWorkers() {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
