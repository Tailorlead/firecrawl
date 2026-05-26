import { redisRateLimitClient } from "../../services/rate-limiter";
import { logger as defaultLogger } from "../../lib/logger";

const METRICS_PREFIX = "search:metrics:v2";
const METRICS_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SearchEngine = "ddg" | "searxng" | "fireengine" | "browser";

export type SearchOutcome =
  | "ok"
  | "empty"
  | "blocked"
  | "timeout"
  | "error"
  | "cold_skipped";

export type CacheOutcome = "hit" | "miss" | "set" | "skipped";

function hourBucket(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}`;
}

async function bump(key: string): Promise<void> {
  try {
    const pipeline = redisRateLimitClient.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, METRICS_TTL_SECONDS, "NX");
    await pipeline.exec();
  } catch (err) {
    // Metrics must never break the search flow.
    defaultLogger.debug("searchMetrics: failed to bump counter", {
      key,
      err: (err as Error).message,
    });
  }
}

export async function recordEngine(
  engine: SearchEngine,
  outcome: SearchOutcome,
): Promise<void> {
  const bucket = hourBucket();
  await bump(`${METRICS_PREFIX}:engine:${engine}:${outcome}:${bucket}`);
}

export async function recordCache(outcome: CacheOutcome): Promise<void> {
  const bucket = hourBucket();
  await bump(`${METRICS_PREFIX}:cache:${outcome}:${bucket}`);
}

export async function recordLatency(
  engine: SearchEngine,
  ms: number,
): Promise<void> {
  // Histogram-light: bucketed counters (50/200/500/1000/2000/5000+ ms).
  const buckets = [50, 200, 500, 1000, 2000, 5000];
  const label =
    buckets.find(b => ms <= b)?.toString() ?? `${buckets[buckets.length - 1]}+`;
  const bucket = hourBucket();
  await bump(`${METRICS_PREFIX}:latency:${engine}:le_${label}:${bucket}`);
}

type MetricRow = {
  metric: string;
  hour: string;
  count: number;
};

/**
 * Returns counters aggregated by metric and hour bucket for the last `hours`
 * hours (UTC), keyed by metric name. Used by the admin endpoint.
 */
export async function readMetrics(hours = 24): Promise<MetricRow[]> {
  const now = new Date();
  const out: MetricRow[] = [];
  const keys: string[] = [];
  const meta: { metric: string; hour: string }[] = [];

  for (let i = 0; i < hours; i++) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const bucket = hourBucket(d);

    const enumerate = (suffix: string, metric: string) => {
      keys.push(`${METRICS_PREFIX}:${suffix}:${bucket}`);
      meta.push({ metric, hour: bucket });
    };

    const engines: SearchEngine[] = ["ddg", "searxng", "fireengine", "browser"];
    const outcomes: SearchOutcome[] = [
      "ok",
      "empty",
      "blocked",
      "timeout",
      "error",
      "cold_skipped",
    ];
    for (const engine of engines) {
      for (const outcome of outcomes) {
        enumerate(`engine:${engine}:${outcome}`, `engine.${engine}.${outcome}`);
      }
    }

    const cacheOutcomes: CacheOutcome[] = ["hit", "miss", "set", "skipped"];
    for (const c of cacheOutcomes) {
      enumerate(`cache:${c}`, `cache.${c}`);
    }
  }

  if (keys.length === 0) return out;

  const values = await redisRateLimitClient.mget(...keys);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (!raw) continue;
    const count = parseInt(raw, 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    out.push({ metric: meta[i].metric, hour: meta[i].hour, count });
  }

  return out;
}
