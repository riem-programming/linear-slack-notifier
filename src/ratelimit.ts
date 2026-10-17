export type RateLimiterOptions = { perIp: number; global: number; windowMs: number; maxKeys: number };

export type RateLimiter = {
  check: (ip: string, nowMs: number) => { allowed: boolean; retryAfterS: number };
  fail: (ip: string, nowMs: number) => void;
  succeed: (ip: string) => void;
  size: () => number;
};

// Sliding window of failure timestamps per address plus one global list; a restart resets it (accepted).
export const createRateLimiter = (o: RateLimiterOptions): RateLimiter => {
  const byIp = new Map<string, number[]>();
  let all: number[] = [];

  const live = (times: number[], nowMs: number): number[] => times.filter((t) => t > nowMs - o.windowMs);
  // Seconds until enough failures leave the window for one more attempt; 0 when under the limit.
  const wait = (times: number[], limit: number, nowMs: number): number => {
    if (times.length < limit) return 0;
    const blocker = times[times.length - limit] as number;
    return Math.max(0, Math.ceil((blocker + o.windowMs - nowMs) / 1000));
  };

  const prune = (nowMs: number): void => {
    for (const [ip, times] of byIp) {
      const kept = live(times, nowMs);
      if (kept.length === 0) byIp.delete(ip);
      else byIp.set(ip, kept);
    }
    // Map iterates in insertion order, so the first keys are the oldest.
    for (const ip of byIp.keys()) {
      if (byIp.size <= o.maxKeys) break;
      byIp.delete(ip);
    }
  };

  return {
    check: (ip, nowMs) => {
      all = live(all, nowMs);
      const retryAfterS = Math.max(wait(live(byIp.get(ip) ?? [], nowMs), o.perIp, nowMs), wait(all, o.global, nowMs));
      return { allowed: retryAfterS === 0, retryAfterS };
    },
    fail: (ip, nowMs) => {
      all = [...live(all, nowMs), nowMs];
      byIp.set(ip, [...live(byIp.get(ip) ?? [], nowMs), nowMs]);
      if (byIp.size > o.maxKeys) prune(nowMs);
    },
    succeed: (ip) => {
      byIp.delete(ip);
    },
    size: () => byIp.size,
  };
};

// Traefik appends the real peer last; earlier entries are client-controlled. Repeated headers arrive joined by Node.
export const clientIp = (xff: string | string[] | undefined, remote: string | undefined): string => {
  const last = typeof xff === "string" ? xff.split(",").pop()?.trim() : undefined;
  return last || remote || "unknown";
};
