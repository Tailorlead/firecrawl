FROM node:18-slim

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright + Patchright dependencies. Patchright reuses the
# Playwright browsers cache (same binary), so installing both is cheap.
# Patchright applies anti-detection patches on top of vanilla Chromium.
RUN npx playwright install chromium --with-deps
RUN npx patchright install chromium || true

RUN npm run build

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

CMD [ "npm", "start" ]
