const FAILURE_TTL_MS = 30_000;

type MemoOptions = { ttl: number; now?: () => number };

// One cache, in-flight promise and failure replay per loader. Failures are never cached as data.
export const memo = <T>(load: () => Promise<T>, { ttl, now = Date.now }: MemoOptions): (() => Promise<T>) => {
  let cache: { at: number; items: T } | null = null;
  let failure: { at: number; error: Error } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (cache && now() - cache.at <= ttl) return Promise.resolve(cache.items);
    // A recent failure is replayed so an outage does not make every request wait for the timeout.
    if (failure && now() - failure.at <= FAILURE_TTL_MS) return Promise.reject(failure.error);
    inFlight ??= load()
      .then((items) => {
        cache = { at: now(), items };
        failure = null;
        return items;
      })
      .catch((error: unknown) => {
        failure = { at: now(), error: error instanceof Error ? error : new Error("Request failed") };
        throw failure.error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
};
