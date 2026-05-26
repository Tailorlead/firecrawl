# SearXNG sidecar (TailorLead fork)

Self-hosted SearXNG instance used by Firecrawl's `apps/api` as a fallback
search engine when DuckDuckGo rate-limits us.

## Why it exists

DuckDuckGo blocks ~30 % of our search traffic from the tl-scraping egress
IP. SearXNG aggregates Brave, Qwant, Mojeek, DDG and Bing under one JSON
endpoint and runs **on the same Docker network as Firecrawl**, so it is
reachable on `http://searxng:8080` without exposing anything publicly.

## Wiring

Set in Dokploy (or `.env`):

```
SEARXNG_ENDPOINT=http://searxng:8080
SEARXNG_ENGINES=brave,qwant,mojeek,duckduckgo
SEARXNG_CATEGORIES=general
SEARXNG_SECRET=<32+ random chars, e.g. openssl rand -hex 32>
```

The `firecrawl-api` orchestrator (`apps/api/src/search/v2/index.ts`) will
automatically fall back to this instance when DDG returns an anti-bot
block, and bypasses it when both fail.

## Healthcheck

`GET /healthz` (handled natively by the searxng image).

## Updating engines

Edit `settings.yml`, redeploy. The container reloads on restart.

## Limits

`cpus: 1.0`, `mem_limit: 1G` — enough for ~5-10 req/s. Bump if usage grows.
