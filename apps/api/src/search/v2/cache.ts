import { createHash } from "crypto";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { SearchV2Response } from "../../lib/entities";
import { logger as defaultLogger } from "../../lib/logger";

const CACHE_PREFIX = "search:v2:cache";

export interface CacheKeyInput {
  query: string;
  lang?: string;
  country?: string;
  tbs?: string;
  location?: string;
  numResults: number;
  type?: string | string[];
}

export function buildCacheKey(input: CacheKeyInput): string {
  const normalized = {
    q: input.query.trim().toLowerCase(),
    lang: (input.lang ?? "").toLowerCase(),
    country: (input.country ?? "").toLowerCase(),
    tbs: input.tbs ?? "",
    location: input.location ?? "",
    n: input.numResults,
    type: Array.isArray(input.type) ? input.type.sort().join(",") : input.type ?? "",
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 24);
  return `${CACHE_PREFIX}:${hash}`;
}

export async function getCachedSearch(
  key: string,
): Promise<SearchV2Response | null> {
  try {
    const raw = await redisRateLimitClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as SearchV2Response;
  } catch (err) {
    defaultLogger.debug("search cache: get failed", {
      err: (err as Error).message,
    });
    return null;
  }
}

export async function setCachedSearch(
  key: string,
  value: SearchV2Response,
  ttlSeconds: number,
): Promise<void> {
  try {
    if (!value || !value.web || value.web.length === 0) return;
    const payload = JSON.stringify(value);
    // Soft cap at 256 KB per entry to avoid Redis bloat on huge responses.
    if (Buffer.byteLength(payload, "utf8") > 256 * 1024) return;
    await redisRateLimitClient.set(key, payload, "EX", ttlSeconds);
  } catch (err) {
    defaultLogger.debug("search cache: set failed", {
      err: (err as Error).message,
    });
  }
}

export async function invalidateByPrefix(prefix: string): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  const fullPrefix = prefix.startsWith(CACHE_PREFIX)
    ? prefix
    : `${CACHE_PREFIX}:${prefix}`;
  do {
    const [next, keys] = await redisRateLimitClient.scan(
      cursor,
      "MATCH",
      `${fullPrefix}*`,
      "COUNT",
      500,
    );
    cursor = next;
    if (keys.length > 0) {
      await redisRateLimitClient.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== "0");
  return deleted;
}
