/**
 * Lightweight stealth HTTP client used by the search engines.
 *
 * Behind a feature flag (SEARCH_HTTP_STEALTH_ENABLED) we route requests
 * through impit (apify/impit) which impersonates a real Chrome TLS/JA3
 * fingerprint at the Rust layer. This is what `undici` can't do, and the
 * single biggest lever to reduce DDG anti-bot blocks.
 *
 * When the flag is off, or impit fails to load (e.g. on a platform where
 * the native binary isn't available), we transparently fall back to
 * undici.fetch so callers don't need to branch.
 */
import * as undici from "undici";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { getSecureDispatcher } from "../../scraper/scrapeURL/engines/utils/safeFetch";

export interface StealthRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | URLSearchParams;
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
}

export interface StealthResponse {
  status: number;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

let cachedImpitModule: any | null | undefined = undefined;
let cachedImpitInstance: any = null;

async function loadImpit(): Promise<any | null> {
  if (cachedImpitModule !== undefined) return cachedImpitModule;
  try {
    // Dynamic, untyped import so type-checking succeeds even when impit is
    // not installed (e.g. dev machines without the prebuilt native binary).
    // The module name is split via a variable to discourage bundlers from
    // following it statically.
    const modName: string = "impit";
    cachedImpitModule = await (Function(
      "m",
      "return import(m)",
    )(modName) as Promise<any>);
  } catch (err) {
    logger.warn(
      "impit not available, falling back to undici for stealth requests",
      { err: (err as Error).message },
    );
    cachedImpitModule = null;
  }
  return cachedImpitModule;
}

async function getImpit(): Promise<any | null> {
  if (cachedImpitInstance) return cachedImpitInstance;
  const mod = await loadImpit();
  if (!mod) return null;
  // The exact export name varies between versions; try both.
  const ImpitCtor = mod.Impit ?? mod.default?.Impit;
  if (!ImpitCtor) return null;
  cachedImpitInstance = new ImpitCtor({
    browser: "chrome",
    ignoreTlsErrors: false,
    // Cookies are handled per-instance by impit automatically.
  });
  return cachedImpitInstance;
}

function isStealthEnabled(): boolean {
  return config.SEARCH_HTTP_STEALTH_ENABLED !== false;
}

async function impitFetch(
  url: string,
  init: StealthRequestInit,
): Promise<StealthResponse> {
  const impit = await getImpit();
  if (!impit) throw new Error("impit_unavailable");
  const resp = await impit.fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    redirect: init.redirect ?? "follow",
    signal: init.signal,
  });
  return {
    status: resp.status,
    headers: resp.headers,
    arrayBuffer: () => resp.arrayBuffer(),
    text: () => resp.text(),
  };
}

async function undiciFallback(
  url: string,
  init: StealthRequestInit,
): Promise<StealthResponse> {
  const resp = await undici.fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    redirect: init.redirect ?? "follow",
    signal: init.signal,
    dispatcher: getSecureDispatcher(false),
  });
  return {
    status: resp.status,
    headers: resp.headers,
    arrayBuffer: () => resp.arrayBuffer() as Promise<ArrayBuffer>,
    text: () => resp.text(),
  };
}

/**
 * Stealth fetch with automatic fallback.
 * Use this for outgoing requests to search engines and other anti-bot
 * sensitive endpoints. SSRF protection is preserved on the undici path
 * via getSecureDispatcher; impit only targets known public hosts.
 */
export async function stealthFetch(
  url: string,
  init: StealthRequestInit = {},
): Promise<StealthResponse> {
  if (isStealthEnabled()) {
    try {
      return await impitFetch(url, init);
    } catch (err) {
      logger.debug("impit failed, falling back to undici", {
        url,
        err: (err as Error).message,
      });
    }
  }
  return undiciFallback(url, init);
}
