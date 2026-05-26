import express, { Request, Response } from 'express';
import type { Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';
import {
  STEALTH_LEVEL,
  STEALTH_LAUNCH_ARGS,
  buildInitScript,
  getChromium,
  shouldUseCamoufox,
  CAMOUFOX_CDP_URL,
} from './helpers/stealth';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(express.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
const MAX_CONCURRENT_PAGES = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? '10', 10) || 10);

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      if (nextResolve) {
        this.permits--;
        nextResolve();
      }
    }
  }

  getAvailablePermits(): number {
    return this.permits;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com'
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
}

let browser: Browser;
let camoufoxBrowser: Browser | null = null;
const INIT_SCRIPT = buildInitScript(STEALTH_LEVEL);

const initializeBrowser = async () => {
  const chromium = await getChromium();
  browser = await chromium.launch({
    headless: true,
    args: STEALTH_LAUNCH_ARGS,
  });
};

/**
 * Connect once (lazy) to the Camoufox sidecar. Supports two transport
 * shapes:
 *   - ws://host:1337  ->  Playwright server (the Python camoufox server)
 *     → use chromium.connect()
 *   - http(s)://host:9222  ->  raw CDP endpoint
 *     → use chromium.connectOverCDP()
 *
 * The sidecar is a Firefox-fork that applies anti-bot patches at the
 * C++ level (canvas, fonts, WebRTC, navigator) — much harder to detect
 * than init scripts. We only route the domains listed in
 * CAMOUFOX_DOMAINS through it.
 */
const getCamoufox = async (): Promise<Browser | null> => {
  if (!CAMOUFOX_CDP_URL) return null;
  if (camoufoxBrowser) return camoufoxBrowser;
  const chromium: any = await getChromium();
  try {
    if (CAMOUFOX_CDP_URL.startsWith('ws://') || CAMOUFOX_CDP_URL.startsWith('wss://')) {
      if (typeof chromium.connect !== 'function') {
        console.warn('Camoufox: chromium.connect() not available in current driver');
        return null;
      }
      camoufoxBrowser = await chromium.connect(CAMOUFOX_CDP_URL);
    } else {
      if (typeof chromium.connectOverCDP !== 'function') {
        console.warn('Camoufox: chromium.connectOverCDP() not available');
        return null;
      }
      camoufoxBrowser = await chromium.connectOverCDP(CAMOUFOX_CDP_URL);
    }
    return camoufoxBrowser;
  } catch (err) {
    console.warn('Camoufox connection failed', (err as Error).message);
    return null;
  }
};

const createContext = async (
  skipTlsVerification: boolean = false,
  targetUrl?: string,
): Promise<BrowserContext> => {
  const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
  const viewport = { width: 1920, height: 1080 };

  const contextOptions: any = {
    userAgent,
    viewport,
    ignoreHTTPSErrors: skipTlsVerification,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
    };
  }

  // Route to Camoufox if the target domain is configured for it.
  let activeBrowser: Browser = browser;
  if (targetUrl && shouldUseCamoufox(targetUrl)) {
    const cf = await getCamoufox();
    if (cf) {
      activeBrowser = cf;
    }
  }

  const newContext = await activeBrowser.newContext(contextOptions);

  if (INIT_SCRIPT) {
    await newContext.addInitScript({ content: INIT_SCRIPT });
  }

  if (BLOCK_MEDIA) {
    await newContext.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', async (route: Route, _request: PlaywrightRequest) => {
      await route.abort();
    });
  }

  // Intercept all requests to avoid loading ads
  await newContext.route('**/*', (route: Route, request: PlaywrightRequest) => {
    const requestUrl = new URL(request.url());
    const hostname = requestUrl.hostname;

    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });

  return newContext;
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
  if (camoufoxBrowser) {
    try { await camoufoxBrowser.close(); } catch {}
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  let headers = null, content = await page.content();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
    if (ct && (ct.toLowerCase().includes("application/json") || ct.toLowerCase().includes("text/plain"))) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
  };
};

app.get('/health', async (_req: Request, res: Response) => {
  try {
    if (!browser) {
      await initializeBrowser();
    }

    const testContext = await createContext();
    const testPage = await testContext.newPage();
    await testPage.close();
    await testContext.close();

    res.status(200).json({
      status: 'healthy',
      stealthLevel: STEALTH_LEVEL,
      maxConcurrentPages: MAX_CONCURRENT_PAGES,
      activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

app.post('/scrape', async (req: Request, res: Response) => {
  const { url, wait_after_load = 0, timeout = 15000, headers, check_selector, skip_tls_verification = false }: UrlModel = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!PROXY_SERVER) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
  }

  if (!browser) {
    await initializeBrowser();
  }

  await pageSemaphore.acquire();

  let requestContext: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    requestContext = await createContext(skip_tls_verification, url);
    page = await requestContext.newPage();

    if (headers) {
      await page.setExtraHTTPHeaders(headers);
    }

    const result = await scrapePage(page, url, 'load', wait_after_load, timeout, check_selector);
    const pageError = result.status !== 200 ? getError(result.status) : undefined;

    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
    }

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      ...(pageError && { pageError })
    });

  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: 'An error occurred while fetching the page.' });
  } finally {
    if (page) await page.close();
    if (requestContext) await requestContext.close();
    pageSemaphore.release();
  }
});

interface SearchDdgInput {
  query: string;
  num_results?: number;
  lang?: string;
  country?: string;
  timeout?: number;
}

interface DdgResult {
  url: string;
  title: string;
  description: string;
}

/**
 * Browser-based DDG search. Runs inside our existing Patchright context
 * so the upstream call carries a realistic browser fingerprint at every
 * layer (TLS, headers, JS environment, mouse trajectory if applicable).
 * Used as the last fallback when both HTTP DDG and SearXNG are cold.
 */
app.post('/search-ddg', async (req: Request, res: Response) => {
  const { query, num_results = 5, lang = 'fr', country = 'fr', timeout = 20000 }: SearchDdgInput = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query is required' });
  }
  if (!browser) {
    await initializeBrowser();
  }

  await pageSemaphore.acquire();
  let ctx: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    ctx = await createContext(false);
    page = await ctx.newPage();

    // Warm-up via Google referer simulation: visit DDG home first, then search.
    await page.goto('https://duckduckgo.com/', { waitUntil: 'domcontentloaded', timeout });

    const params = new URLSearchParams({ q: query, kp: '1' });
    if (country && lang) {
      params.set('kl', `${country.toLowerCase()}-${lang.toLowerCase()}`);
    }
    const url = `https://html.duckduckgo.com/html?${params.toString()}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout });

    // Parse results directly in the page context.
    const results = await page.evaluate(() => {
      const anomaly = document.querySelector('.anomaly-modal__modal');
      if (anomaly) {
        return { blocked: true, items: [] as Array<{ url: string; title: string; description: string }> };
      }
      const items: Array<{ url: string; title: string; description: string }> = [];
      const blocks = Array.from(document.querySelectorAll('.result.web-result'));
      for (const block of blocks) {
        const titleLink = block.querySelector('.result__a') as HTMLAnchorElement | null;
        const snippet = block.querySelector('.result__snippet');
        if (!titleLink || !snippet) continue;
        let href = titleLink.href || '';
        if (href.includes('uddg=')) {
          try {
            const u = new URL(href, 'https://duckduckgo.com');
            const uddg = u.searchParams.get('uddg');
            if (uddg) href = decodeURIComponent(uddg);
          } catch {}
        }
        const title = (titleLink.textContent || '').trim();
        const description = (snippet.textContent || '').trim();
        if (href && title && description) items.push({ url: href, title, description });
      }
      return { blocked: false, items };
    });

    if (results.blocked) {
      return res.status(503).json({ error: 'ddg_blocked' });
    }
    return res.json({ web: results.items.slice(0, num_results) as DdgResult[] });
  } catch (error) {
    console.error('search-ddg error:', error);
    return res.status(500).json({ error: 'search_failed' });
  } finally {
    if (page) await page.close();
    if (ctx) await ctx.close();
    pageSemaphore.release();
  }
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port} (stealth level: ${STEALTH_LEVEL})`);
  });
});

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdownBrowser().then(() => {
      console.log('Browser closed');
      process.exit(0);
    });
  });
}
