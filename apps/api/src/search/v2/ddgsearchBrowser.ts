/**
 * Last-resort DDG search engine that runs inside a real (Patchright)
 * browser via the existing playwright-service microservice. We only
 * call this when both HTTP DDG and SearXNG are cold — it's slower
 * (~3-6s per query) but indistinguishable from a real user because
 * it carries the same TLS + JS environment as the scrape browser.
 */
import axios from "axios";
import { config } from "../../config";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger as defaultLogger } from "../../lib/logger";

interface BrowserSearchOptions {
  num_results?: number;
  lang?: string;
  country?: string;
  timeout?: number;
}

function resolveBaseUrl(): string | null {
  // Prefer an explicit override; otherwise reuse the existing playwright
  // microservice URL by stripping the trailing /scrape path.
  const explicit = config.SEARCH_BROWSER_FALLBACK_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const pw = config.PLAYWRIGHT_MICROSERVICE_URL;
  if (!pw) return null;
  return pw.replace(/\/scrape\/?$/, "").replace(/\/$/, "");
}

export async function ddgSearchBrowser(
  query: string,
  options: BrowserSearchOptions = {},
): Promise<SearchV2Response> {
  if (config.SEARCH_BROWSER_FALLBACK_ENABLED === false) {
    return {};
  }
  const base = resolveBaseUrl();
  if (!base) {
    defaultLogger.debug("ddgSearchBrowser: no playwright URL configured");
    return {};
  }
  const url = `${base}/search-ddg`;
  const num_results = Math.max(1, options.num_results ?? 5);
  const payload = {
    query,
    num_results,
    lang: options.lang ?? "fr",
    country: options.country ?? "fr",
    timeout: options.timeout ?? 20000,
  };

  try {
    const resp = await axios.post(url, payload, {
      timeout: (options.timeout ?? 20000) + 5000,
      validateStatus: () => true,
    });
    if (resp.status === 503 && resp.data?.error === "ddg_blocked") {
      throw new Error("Browser fallback: DuckDuckGo: Blocked by anti-bot measures.");
    }
    if (resp.status >= 400) {
      defaultLogger.warn("ddgSearchBrowser: upstream error", {
        status: resp.status,
        body: typeof resp.data === "object" ? resp.data?.error : String(resp.data),
      });
      return {};
    }
    const web = (resp.data?.web ?? []) as WebSearchResult[];
    if (!Array.isArray(web) || web.length === 0) return {};
    return { web };
  } catch (err: any) {
    if (String(err?.message).includes("Blocked by anti-bot")) throw err;
    defaultLogger.error("ddgSearchBrowser: request failed", {
      err: err?.message,
    });
    return {};
  }
}
