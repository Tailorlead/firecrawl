import * as undici from "undici";
import { config } from "../../config";
import { JSDOM } from "jsdom";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";
import { getSecureDispatcher } from "../../scraper/scrapeURL/engines/utils/safeFetch";

class DDGAntiBotError extends Error {
  constructor() {
    super("Blocked by DuckDuckGo Anti-Bot measures");
  }
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

interface SearchOptions {
  tbs?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  timeout?: number;
}

function cleanUrl(href: string): string {
  if (href.includes("uddg=")) {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  }
  return href;
}

function isBlockHtml(doc: Document): boolean {
  if (doc.querySelector(".anomaly-modal__modal")) return true;
  // DDG also serves a plain "Unfortunately, bots use DuckDuckGo too" page
  // without the modal class — detect by text in <body>.
  const bodyText = doc.body?.textContent?.toLowerCase() ?? "";
  if (
    bodyText.includes("anomaly") ||
    bodyText.includes("unusual traffic") ||
    bodyText.includes("blocked")
  ) {
    return true;
  }
  return false;
}

function extractResults(
  document: Document,
  seenUrls: Set<string>,
): WebSearchResult[] {
  if (isBlockHtml(document)) {
    throw new DDGAntiBotError();
  }

  const results: WebSearchResult[] = [];
  const blocks = Array.from(document.querySelectorAll(".result.web-result"));

  for (const block of blocks) {
    const titleLink = block.querySelector(
      ".result__a",
    ) as HTMLAnchorElement | null;
    const snippet = block.querySelector(".result__snippet");

    if (!titleLink || !snippet) continue;

    const rawUrl = titleLink.href?.trim();
    const title = titleLink.textContent?.trim();
    const description = snippet.textContent?.trim();

    if (rawUrl && title && description) {
      const url = cleanUrl(rawUrl);
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ url, title, description });
      }
    }
  }

  return results;
}

function getNextPageData(document: Document): URLSearchParams | null {
  const nextButton = document.querySelector(
    'input[type="submit"][class="btn btn--alt"][value="Next"]',
  ) as HTMLInputElement | null;

  if (!nextButton) return null;

  const nextForm = nextButton.closest("form") as HTMLFormElement | null;
  if (!nextForm) return null;

  const formData = new URLSearchParams();
  const inputs = Array.from(nextForm.querySelectorAll("input"));

  for (const input of inputs) {
    const name = input.getAttribute("name");
    const value = input.getAttribute("value");
    if (name && value !== null) {
      formData.set(name, value);
    }
  }

  return formData;
}

/**
 * Builds the realistic header set sent on every DDG request. The intent is to
 * mirror a Chrome 120 navigation as closely as undici allows. JA3-level TLS
 * impersonation lives in a later phase (got-scraping), but matching headers
 * already lifts the block rate noticeably.
 */
function buildHeaders(
  userAgent: string,
  referer?: string,
  cookieHeader?: string,
): Record<string, string> {
  const acceptLanguage =
    config.SEARCH_DDG_ACCEPT_LANGUAGE ?? "en-US,en;q=0.9";
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "cross-site" : "none",
    "Sec-Fetch-User": "?1",
    DNT: "1",
  };
  if (userAgent.includes("Chrome/")) {
    headers["sec-ch-ua"] =
      '"Chromium";v="120", "Google Chrome";v="120", "Not?A_Brand";v="24"';
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = userAgent.includes("Mac")
      ? '"macOS"'
      : userAgent.includes("Linux")
        ? '"Linux"'
        : '"Windows"';
  }
  if (referer) headers["Referer"] = referer;
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  return headers;
}

function parseSetCookies(response: undici.Response): string {
  // Reduce Set-Cookie headers to a single Cookie line for reuse on next hit.
  const setCookieHeaders =
    (response.headers as any).getSetCookie?.() ??
    (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
  return (setCookieHeaders as string[])
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * Pre-warm: fetch DDG homepage once to obtain session cookies (vqd, kl, ...)
 * so the subsequent /html search is treated as a continuation of a normal
 * navigation. Returns the Cookie header to reuse, or empty string on failure.
 */
async function prewarmSession(
  userAgent: string,
  timeoutMs: number,
): Promise<string> {
  if (!config.SEARCH_DDG_PREWARM_ENABLED) return "";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.min(timeoutMs, 4000));
  try {
    const resp = await undici.fetch("https://duckduckgo.com/", {
      dispatcher: getSecureDispatcher(false),
      redirect: "follow",
      headers: buildHeaders(userAgent, config.SEARCH_DDG_REFERER),
      signal: controller.signal,
    });
    // Drain body so the connection can be reused / closed cleanly.
    await resp.arrayBuffer().catch(() => undefined);
    return parseSetCookies(resp);
  } catch (err: any) {
    logger.debug("DDG pre-warm failed (continuing without cookies)", {
      err: err?.message,
    });
    return "";
  } finally {
    clearTimeout(t);
  }
}

export async function ddgSearch(
  term: string,
  num_results = 5,
  options: SearchOptions = {},
): Promise<SearchV2Response> {
  const {
    lang = "en",
    country = "us",
    location,
    tbs,
    timeout = 5000,
  } = options;

  try {
    const userAgent =
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const params = new URLSearchParams({ q: term, kp: "1" });

    if (location) {
      params.set("kl", location);
    } else if (country && lang) {
      params.set("kl", `${country.toLowerCase()}-${lang.toLowerCase()}`);
    }

    if (tbs && (["d", "w", "m", "y"].includes(tbs) || tbs.includes(".."))) {
      params.set("df", tbs);
    }

    // Pre-warm to get session cookies before hitting /html.
    const sessionCookies = await prewarmSession(userAgent, timeout);

    const results: WebSearchResult[] = [];
    const seenUrls = new Set<string>();
    let isFirstPage = true;
    let nextPageData: URLSearchParams | null = params;

    const maxRetries = Math.max(0, Number(config.SEARCH_DDG_MAX_RETRIES ?? 1));
    let antiBotRetries = 0;

    while (results.length < num_results && nextPageData) {
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        if (abortController) {
          abortController.abort();
        }
      }, timeout);

      try {
        let response: undici.Response;

        if (isFirstPage) {
          response = await undici.fetch(
            `https://html.duckduckgo.com/html?${params.toString()}`,
            {
              dispatcher: getSecureDispatcher(false),
              redirect: "follow",
              headers: buildHeaders(
                userAgent,
                config.SEARCH_DDG_REFERER,
                sessionCookies || undefined,
              ),
              signal: abortController.signal,
            },
          );
        } else {
          response = await undici.fetch(`https://html.duckduckgo.com/html`, {
            method: "POST",
            body: nextPageData.toString(),
            dispatcher: getSecureDispatcher(false),
            redirect: "follow",
            headers: {
              ...buildHeaders(
                userAgent,
                "https://html.duckduckgo.com/",
                sessionCookies || undefined,
              ),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            signal: abortController.signal,
          });
        }

        // Explicit rate-limit / block detection BEFORE parsing.
        if (response.status === 429 || response.status === 403) {
          throw new DDGAntiBotError();
        }

        const buf = Buffer.from(await response.arrayBuffer());
        const dom = new JSDOM(buf.toString("utf8"));
        const doc = dom.window.document;

        const newResults = extractResults(doc, seenUrls);

        isFirstPage = false;
        antiBotRetries = 0;

        results.push(...newResults);

        if (newResults.length === 0) break;

        nextPageData = getNextPageData(doc);
      } catch (error: any) {
        if (error instanceof DDGAntiBotError) {
          if (antiBotRetries++ >= maxRetries) {
            throw error;
          }
          logger.warn(
            "DuckDuckGo: Encountered anti-bot measures, retrying once...",
            {
              attempt: antiBotRetries,
              term,
            },
          );
        } else {
          throw error;
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      await new Promise(r => setTimeout(r, 300));
    }

    if (results.length === 0) {
      logger.warn("DuckDuckGo: No results found", { term });
      return {};
    }

    return { web: results.slice(0, num_results) };
  } catch (error: any) {
    if (error instanceof DDGAntiBotError) {
      if (config.TEST_SUITE_SELF_HOSTED) {
        logger.warn(
          "DuckDuckGo: Blocked by anti-bot measures, returning dummy page for test suite...",
          { term },
        );

        return {
          web: [
            {
              url: "https://example.com",
              title: "DDG Anti-Bot Test Page",
              description:
                "DDG Anti-Bot triggered, returning dummy page for test suite",
              position: 1,
              category: "web",
              html: "<html><body><h1>Hello, World!</h1></body></html>",
              rawHtml:
                "<html><head><title>Hello!</title></head><body><h1>Hello, World!</h1></body></html>",
              links: [],
            },
          ],
        };
      }

      logger.error("DuckDuckGo: Blocked by anti-bot measures", { term });
      throw new Error("DuckDuckGo: Blocked by anti-bot measures.");
    }

    if (error.response?.status === 429) {
      logger.warn("DuckDuckGo: Too many requests, try again later.", {
        status: error.response.status,
        statusText: error.response.statusText,
      });
      throw new Error("DuckDuckGo: Too many requests, try again later.");
    }
    logger.error("DuckDuckGo search error", { error: error.message, term });
    throw error;
  }
}
