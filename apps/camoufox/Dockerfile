# Camoufox sidecar — exposes a Playwright server on ws://0.0.0.0:1337
# that the playwright-service workers connect to for the hardest sites
# (Cloudflare Turnstile, Datadome, fingerprint.com). Camoufox is a
# Firefox fork that patches anti-bot detection at the C++ level — much
# harder to detect than init scripts injected into Chromium.
#
# This image is only built when SCRAPE_USE_CAMOUFOX=true and the
# CAMOUFOX_DOMAINS env var is populated; otherwise the firecrawl stack
# runs without it and routes everything through the Patchright/Chromium
# workers.
FROM python:3.12-slim

# Camoufox runtime dependencies (Firefox shared libs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libdbus-glib-1-2 \
    fonts-liberation fonts-noto-color-emoji ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "camoufox[geoip]==0.4.*" "playwright>=1.40,<2"

# Download Camoufox browser binary once at build time.
RUN python -m camoufox fetch || true

ENV CAMOUFOX_SERVER_PORT=1337
EXPOSE 1337

# `--server` runs a Playwright WebSocket server bound to all interfaces
# inside the container (network "backend"-scoped, not exposed publicly).
# Workers connect via chromium.connect("ws://camoufox:1337").
CMD ["python", "-m", "camoufox", "server", "--port", "1337", "--host", "0.0.0.0"]
