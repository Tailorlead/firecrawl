# Camoufox sidecar (TailorLead fork)

Self-hosted [Camoufox](https://github.com/daijro/camoufox) instance used
as a per-domain stealth escape hatch when Patchright + init scripts
aren't enough (Cloudflare Turnstile interactive, Datadome,
Fingerprint.com aggressive setups).

## Why a separate container

Camoufox is a Firefox fork that patches anti-bot detection at the C++
level (canvas, fonts, audio, WebGL, WebRTC, navigator, timezone). It
ships as a Python package that can act as a Playwright WS server. We
isolate it in its own container so:

- Its memory and CPU envelope are bounded independently
- The Chromium-based playwright-service stays untouched
- It is opt-in per domain via `CAMOUFOX_DOMAINS` env var

## How to enable

1. Generate or pick an instance secret — none required (the WS endpoint
   lives only on the internal `backend` network).

2. In Dokploy, set on the `api` and `playwright-service` services:

```
CAMOUFOX_CDP_URL=ws://camoufox:1337
CAMOUFOX_DOMAINS=linkedin.com,sales-navigator.linkedin.com,glassdoor.com
```

3. Redeploy. The `camoufox` service will build (~200 MB image, first
   build ~3 min) and start.

## Verifying it routes correctly

```bash
ssh tl-scraping "sudo docker logs --tail 20 compose-...-camoufox-1"
# look for "Server listening on ws://0.0.0.0:1337"

# Force a scrape of a configured domain and tail the playwright-service
# logs — you should see `connectOverCDP` / `connect` succeed once.
```

## Resource envelope

`cpus: 2.0`, `mem_limit: 2G` — Camoufox is heavier than Chromium per
context (~250 MB / page). One worker is enough for the domains we
route to it; bump to `replicas: 2` if usage grows.

## Limits

- The Camoufox Python package follows upstream Firefox patches; expect
  a release every 2-3 months. To upgrade, bump the version pin in
  `Dockerfile` and rebuild.
- WS endpoint is **not** authenticated. Do not expose it outside the
  Docker `backend` network.
