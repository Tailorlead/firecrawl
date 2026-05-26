/**
 * Browser stealth helpers shared by /scrape and /search-ddg.
 *
 * The runtime selects between vanilla Playwright and Patchright based on
 * the SCRAPE_STEALTH_LEVEL env var:
 *   - "off"    -> playwright (legacy behaviour)
 *   - "medium" -> patchright (CDP leaks fixed) + minimal init scripts
 *   - "high"   -> patchright + full init scripts (canvas / webrtc / fonts /
 *                 webdriver / plugins / chrome.runtime) + ghost cursor
 *
 * Patchright is a drop-in replacement for the playwright module — same
 * imports, same API. We import it lazily so that environments without it
 * keep working.
 */

export type StealthLevel = "off" | "medium" | "high";

export const STEALTH_LEVEL: StealthLevel =
  ((process.env.SCRAPE_STEALTH_LEVEL || "high").toLowerCase() as StealthLevel) || "high";
export const BLOCK_WEBRTC = (process.env.SCRAPE_BLOCK_WEBRTC || "true").toLowerCase() !== "false";
export const HIDE_CANVAS = (process.env.SCRAPE_HIDE_CANVAS || "true").toLowerCase() !== "false";
export const CAMOUFOX_CDP_URL = process.env.CAMOUFOX_CDP_URL || null;
export const CAMOUFOX_DOMAINS = (process.env.CAMOUFOX_DOMAINS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

type ChromiumLike = {
  launch: (...args: any[]) => Promise<any>;
  connectOverCDP?: (url: string) => Promise<any>;
};

let cachedChromium: ChromiumLike | null = null;

export async function getChromium(): Promise<ChromiumLike> {
  if (cachedChromium) return cachedChromium;
  if (STEALTH_LEVEL === "off") {
    const mod = await import("playwright");
    cachedChromium = mod.chromium;
  } else {
    try {
      // patchright keeps the same import shape as playwright.
      const mod: any = await import("patchright");
      cachedChromium = (mod.chromium ?? mod.default?.chromium) as ChromiumLike;
    } catch (err) {
      // Fallback to vanilla playwright if patchright didn't ship for this arch.
      const mod = await import("playwright");
      cachedChromium = mod.chromium;
      // eslint-disable-next-line no-console
      console.warn(
        "[stealth] patchright not available, falling back to playwright",
        (err as Error).message,
      );
    }
  }
  return cachedChromium!;
}

/**
 * Init script that runs in every new page before any site JS executes.
 * Patches the DOM / Web API surfaces most commonly inspected by anti-bot
 * stacks (Cloudflare, Datadome, Akamai, Fingerprint.com).
 */
export function buildInitScript(level: StealthLevel): string {
  if (level === "off") return "";

  const lines: string[] = [];

  // navigator.webdriver — always
  lines.push(
    `Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });`,
  );

  if (level === "high") {
    // navigator.plugins / mimeTypes — non-zero array to mimic real Chrome
    lines.push(`(() => {
      const fakePlugin = {
        0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf' },
        name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer',
        description: 'Portable Document Format', length: 1,
      };
      const pluginArray = Object.create(PluginArray.prototype);
      Object.defineProperty(pluginArray, 'length', { value: 1 });
      Object.defineProperty(pluginArray, '0', { value: fakePlugin });
      Object.defineProperty(Navigator.prototype, 'plugins', { get: () => pluginArray });
    })();`);

    // navigator.languages cohérent fr/en
    lines.push(
      `Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });`,
    );

    // chrome.runtime — present on real Chrome, absent on headless
    lines.push(`if (!('chrome' in window) || !window.chrome.runtime) {
      try {
        window.chrome = window.chrome || {};
        window.chrome.runtime = { id: undefined, connect: () => {}, sendMessage: () => {} };
      } catch (e) {}
    }`);

    // permissions.query mismatch (notifications)
    lines.push(`(() => {
      const orig = Permissions.prototype.query;
      Permissions.prototype.query = function (params) {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return orig.call(this, params);
      };
    })();`);
  }

  if (HIDE_CANVAS && level === "high") {
    // Canvas noise to defeat fingerprinting via toDataURL / getImageData
    lines.push(`(() => {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const data = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < data.data.length; i += 4) {
            data.data[i]     ^= (Math.random() * 2) | 0;
            data.data[i + 1] ^= (Math.random() * 2) | 0;
            data.data[i + 2] ^= (Math.random() * 2) | 0;
          }
          ctx.putImageData(data, 0, 0);
        }
        return origToDataURL.apply(this, args);
      };
    })();`);
  }

  if (BLOCK_WEBRTC) {
    // Block local-IP leaks from WebRTC entirely. Sites that legitimately
    // need WebRTC (call apps) wouldn't be scraped here.
    lines.push(`(() => {
      try {
        window.RTCPeerConnection = class { constructor() { throw new Error('blocked'); } };
        window.webkitRTCPeerConnection = window.RTCPeerConnection;
        if ('mozRTCPeerConnection' in window) window.mozRTCPeerConnection = window.RTCPeerConnection;
      } catch (e) {}
    })();`);
  }

  return lines.join("\n");
}

export const STEALTH_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--disable-gpu",
  // Anti-detection flags applied by Patchright are additive; these two
  // make us non-distinguishable from a regular Chrome user-launch even if
  // Patchright is missing.
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,WebRtcHideLocalIpsWithMdns",
];

/**
 * Returns true if the given URL host (or any parent domain) is configured
 * to be routed through the Camoufox CDP sidecar.
 */
export function shouldUseCamoufox(targetUrl: string): boolean {
  if (!CAMOUFOX_CDP_URL || CAMOUFOX_DOMAINS.length === 0) return false;
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return CAMOUFOX_DOMAINS.some(
    d => host === d || host.endsWith("." + d),
  );
}
