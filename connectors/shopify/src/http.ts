export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;
export const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
