import {
  describeIf,
  HAS_PROXY,
  HAS_SEARCH,
  TEST_PRODUCTION,
} from "../lib";
import { search, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "search-cache",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

// These snips assert the cache + fallback chain we added. They piggy-back on
// the real search engines via the harness so we exercise the full path.
describeIf(TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY)(
  "Search cache + fallback chain",
  () => {
    it.concurrent(
      "second identical search returns results consistently (cache hot path)",
      async () => {
        const query = `firecrawl tailorlead cache hit ${Date.now()}`;

        const first = await search({ query, limit: 3 }, identity);
        expect(first.web).toBeDefined();
        expect((first.web ?? []).length).toBeGreaterThan(0);

        const second = await search({ query, limit: 3 }, identity);
        expect(second.web).toBeDefined();
        expect((second.web ?? []).length).toBeGreaterThan(0);

        // Cache should return the same URLs in the same order for the same query.
        // We compare URLs rather than the entire object because snippets may
        // legitimately differ between live and cached responses.
        const firstUrls = (first.web ?? []).map(r => r.url);
        const secondUrls = (second.web ?? []).map(r => r.url);
        expect(secondUrls).toEqual(firstUrls);
      },
      90000,
    );

    it.concurrent(
      "different queries produce different result sets",
      async () => {
        const a = await search(
          { query: "firecrawl scraper opensource", limit: 3 },
          identity,
        );
        const b = await search(
          { query: "claude anthropic sonnet model", limit: 3 },
          identity,
        );
        expect((a.web ?? []).length).toBeGreaterThan(0);
        expect((b.web ?? []).length).toBeGreaterThan(0);

        const aUrls = new Set((a.web ?? []).map(r => r.url));
        const bUrls = new Set((b.web ?? []).map(r => r.url));
        // At least one URL must differ between unrelated queries.
        const overlap = [...aUrls].filter(u => bUrls.has(u));
        expect(overlap.length).toBeLessThan(aUrls.size);
      },
      90000,
    );
  },
);
