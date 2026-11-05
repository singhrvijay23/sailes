/**
 * In-process job runner. Jobs for one shop run one at a time; a job with the same key that is
 * already waiting is not queued twice (Shopify sends bursts of products/update). Missed work is
 * caught by the periodic full resync, so the queue does not need to survive restarts.
 */
export type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export class JobQueue {
  private chains = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  private inflight = new Set<Promise<void>>();

  constructor(private log: Logger, private retries = 2, private retryDelayMs = 5000) {}

  enqueue(shop: string, key: string, run: () => Promise<unknown>, retryable: (e: unknown) => boolean = () => true) {
    const id = `${shop}:${key}`;
    if (this.pending.has(id)) return;
    this.pending.add(id);
    const prev = this.chains.get(shop) ?? Promise.resolve();
    const next = prev.then(async () => {
      this.pending.delete(id);
      for (let attempt = 0; ; attempt++) {
        try {
          await run();
          return;
        } catch (e) {
          if (attempt >= this.retries || !retryable(e)) {
            this.log.error({ shop, job: key, err: (e as Error).message }, 'job failed');
            return;
          }
          await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
        }
      }
    });
    this.chains.set(shop, next);
    this.inflight.add(next);
    void next.finally(() => {
      this.inflight.delete(next);
      if (this.chains.get(shop) === next) this.chains.delete(shop);
    });
  }

  /** Resolves when every queued job has finished (tests and shutdown). */
  async drain() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}
