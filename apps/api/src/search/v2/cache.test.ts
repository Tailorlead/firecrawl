import { buildCacheKey } from "./cache";

describe("buildCacheKey", () => {
  it("is deterministic for the same inputs", () => {
    const a = buildCacheKey({
      query: "CFO Acme",
      lang: "fr",
      country: "fr",
      numResults: 5,
    });
    const b = buildCacheKey({
      query: "CFO Acme",
      lang: "fr",
      country: "fr",
      numResults: 5,
    });
    expect(a).toBe(b);
  });

  it("normalizes case and surrounding whitespace", () => {
    const a = buildCacheKey({
      query: "  CFO Acme  ",
      lang: "FR",
      country: "FR",
      numResults: 5,
    });
    const b = buildCacheKey({
      query: "cfo acme",
      lang: "fr",
      country: "fr",
      numResults: 5,
    });
    expect(a).toBe(b);
  });

  it("differs when numResults differs", () => {
    const a = buildCacheKey({ query: "x", numResults: 5 });
    const b = buildCacheKey({ query: "x", numResults: 10 });
    expect(a).not.toBe(b);
  });

  it("differs when country differs", () => {
    const a = buildCacheKey({ query: "x", country: "fr", numResults: 5 });
    const b = buildCacheKey({ query: "x", country: "us", numResults: 5 });
    expect(a).not.toBe(b);
  });

  it("is stable across type array ordering", () => {
    const a = buildCacheKey({
      query: "x",
      numResults: 5,
      type: ["web", "news"],
    });
    const b = buildCacheKey({
      query: "x",
      numResults: 5,
      type: ["news", "web"],
    });
    expect(a).toBe(b);
  });

  it("produces keys under the expected namespace", () => {
    const k = buildCacheKey({ query: "x", numResults: 5 });
    expect(k.startsWith("search:v2:cache:")).toBe(true);
  });
});
