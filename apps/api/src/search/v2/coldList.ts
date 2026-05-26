import { redisRateLimitClient } from "../../services/rate-limiter";
import { logger as defaultLogger } from "../../lib/logger";
import type { SearchEngine } from "./searchMetrics";

const COLD_PREFIX = "search:v2:cold";

/**
 * Marks an engine as "cold" — i.e. recently failed or rate-limited.
 * The orchestrator skips it until the TTL expires, falling through to the
 * next engine in the chain. This prevents hammering an engine that's
 * already known to be blocking us.
 */
export async function markCold(
  engine: SearchEngine,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redisRateLimitClient.set(
      `${COLD_PREFIX}:${engine}`,
      String(Date.now()),
      "EX",
      Math.max(1, Math.floor(ttlSeconds)),
    );
  } catch (err) {
    defaultLogger.debug("coldList: failed to mark cold", {
      engine,
      err: (err as Error).message,
    });
  }
}

export async function isCold(engine: SearchEngine): Promise<boolean> {
  try {
    const v = await redisRateLimitClient.get(`${COLD_PREFIX}:${engine}`);
    return v !== null;
  } catch {
    return false;
  }
}

export async function clearCold(engine: SearchEngine): Promise<void> {
  try {
    await redisRateLimitClient.del(`${COLD_PREFIX}:${engine}`);
  } catch {
    /* ignore */
  }
}
