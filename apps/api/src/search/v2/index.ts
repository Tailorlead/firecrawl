import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import { buildCacheKey, getCachedSearch, setCachedSearch } from "./cache";
import { isCold, markCold } from "./coldList";
import {
  recordCache,
  recordEngine,
  recordLatency,
  type SearchEngine,
} from "./searchMetrics";

class EngineBlockedError extends Error {
  constructor(public engine: SearchEngine) {
    super(`Search engine "${engine}" is blocked / rate-limited`);
  }
}

interface SearchInput {
  query: string;
  logger: Logger;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
}

function hasResults(r: SearchV2Response | undefined): r is SearchV2Response {
  return !!r && Array.isArray(r.web) && r.web.length > 0;
}

async function runWithMetrics(
  engine: SearchEngine,
  logger: Logger,
  fn: () => Promise<SearchV2Response>,
): Promise<SearchV2Response | undefined> {
  const started = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    await recordLatency(engine, elapsed);
    if (hasResults(result)) {
      await recordEngine(engine, "ok");
      return result;
    }
    await recordEngine(engine, "empty");
    return undefined;
  } catch (err: any) {
    const elapsed = Date.now() - started;
    await recordLatency(engine, elapsed);
    const message = String(err?.message ?? err);
    let outcome: "blocked" | "timeout" | "error" = "error";
    if (
      message.includes("Blocked by") ||
      message.includes("anti-bot") ||
      message.includes("Too many requests")
    ) {
      outcome = "blocked";
    } else if (message.toLowerCase().includes("timeout")) {
      outcome = "timeout";
    }
    await recordEngine(engine, outcome);
    if (outcome === "blocked") {
      logger.warn(`Search engine ${engine} blocked, falling through`, {
        error: message,
      });
      throw new EngineBlockedError(engine);
    }
    logger.error(`Search engine ${engine} failed`, { error: message });
    return undefined;
  }
}

export async function search({
  query,
  logger,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
}: SearchInput): Promise<SearchV2Response> {
  // Fire-engine takes absolute priority and bypasses cache/cold list (commercial path).
  if (config.FIRE_ENGINE_BETA_URL) {
    logger.info("Using fire engine search");
    try {
      const results = await fire_engine_search_v2(query, {
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        type,
        enterprise,
      });
      await recordEngine("fireengine", hasResults(results) ? "ok" : "empty");
      return results;
    } catch (err: any) {
      await recordEngine("fireengine", "error");
      logger.error("Fire engine search failed", { error: err?.message });
      return {};
    }
  }

  // --- Cache lookup ---
  const cacheEnabled = config.SEARCH_CACHE_ENABLED !== false;
  const cacheKey = buildCacheKey({
    query,
    lang,
    country,
    tbs,
    location,
    numResults: num_results,
    type: Array.isArray(type) ? type.map(String) : type ? String(type) : undefined,
  });

  if (cacheEnabled) {
    const cached = await getCachedSearch(cacheKey);
    if (cached && hasResults(cached)) {
      await recordCache("hit");
      logger.info("Search cache hit", { cacheKey, query });
      return cached;
    }
    await recordCache("miss");
  } else {
    await recordCache("skipped");
  }

  // --- Engine chain with cold-list awareness ---
  const ddgCold = await isCold("ddg");
  const searxngConfigured = !!config.SEARXNG_ENDPOINT;
  const searxngCold = searxngConfigured ? await isCold("searxng") : true;

  // 1) DDG (skip if cold)
  if (!ddgCold) {
    try {
      const ddgResults = await runWithMetrics("ddg", logger, () =>
        ddgSearch(query, num_results, {
          tbs,
          lang,
          country,
          proxy,
          timeout,
        }),
      );
      if (hasResults(ddgResults)) {
        if (cacheEnabled) {
          await setCachedSearch(cacheKey, ddgResults, config.SEARCH_CACHE_TTL_SEC);
          await recordCache("set");
        }
        return ddgResults;
      }
    } catch (err) {
      if (err instanceof EngineBlockedError) {
        await markCold("ddg", config.SEARCH_DDG_COLD_TTL_SEC);
        logger.warn(`DDG marked cold for ${config.SEARCH_DDG_COLD_TTL_SEC}s`);
      } else {
        throw err;
      }
    }
  } else {
    await recordEngine("ddg", "cold_skipped");
    logger.info("DDG is cold, skipping to SearXNG fallback");
  }

  // 2) SearXNG fallback (if configured and not cold)
  if (searxngConfigured && !searxngCold) {
    try {
      const sxResults = await runWithMetrics("searxng", logger, () =>
        searxng_search(query, {
          num_results,
          tbs,
          filter,
          lang,
          country,
          location,
        }),
      );
      if (hasResults(sxResults)) {
        if (cacheEnabled) {
          await setCachedSearch(cacheKey, sxResults, config.SEARCH_CACHE_TTL_SEC);
          await recordCache("set");
        }
        return sxResults;
      }
    } catch (err) {
      if (err instanceof EngineBlockedError) {
        await markCold("searxng", config.SEARCH_SEARXNG_COLD_TTL_SEC);
        logger.warn(
          `SearXNG marked cold for ${config.SEARCH_SEARXNG_COLD_TTL_SEC}s`,
        );
      } else {
        throw err;
      }
    }
  } else if (searxngConfigured) {
    await recordEngine("searxng", "cold_skipped");
  }

  // 3) Last-resort retry on DDG if everything else is cold (and DDG was cold).
  // This handles the pathological case where the cold lists drift; we'd rather
  // return something than empty.
  if (ddgCold) {
    try {
      const ddgRetry = await runWithMetrics("ddg", logger, () =>
        ddgSearch(query, num_results, { tbs, lang, country, proxy, timeout }),
      );
      if (hasResults(ddgRetry)) {
        if (cacheEnabled) {
          await setCachedSearch(cacheKey, ddgRetry, config.SEARCH_CACHE_TTL_SEC);
          await recordCache("set");
        }
        return ddgRetry;
      }
    } catch {
      /* fall through */
    }
  }

  logger.warn("All search engines exhausted, returning empty response", {
    query,
  });
  return {};
}
