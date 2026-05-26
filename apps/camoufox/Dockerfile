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
# libgtk-3-0 + libgdk-pixbuf-2.0-0 sont requis par le binaire Firefox de
# Camoufox (XPCOMGlueLoad fail sinon).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libdbus-glib-1-2 \
    libgtk-3-0 libgdk-pixbuf-2.0-0 libx11-xcb1 libxtst6 \
    fonts-liberation fonts-noto-color-emoji ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# IMPORTANT: pin playwright==1.49.1 because camoufox 0.4's launchServer
# Node wrapper requires `browserServerImpl.js` which was removed from the
# Playwright driver bundle in 1.50+. 1.49.1 is the last version that ships
# it and is still compatible with camoufox.
RUN pip install --no-cache-dir "camoufox[geoip]==0.4.*" "playwright==1.49.1"

# Download Camoufox browser binary + GeoIP DB once at build time.
RUN python -m camoufox fetch
RUN python -m camoufox geoip download || true

ENV CAMOUFOX_SERVER_PORT=1337
ENV CAMOUFOX_SERVER_HOST=0.0.0.0
EXPOSE 1337

# `python -m camoufox server` has no host/port flags in 0.4, so we call
# the launch_server() Python API ourselves and pass host/port via env.
COPY launch_server.py /opt/launch_server.py
CMD ["python", "/opt/launch_server.py"]
