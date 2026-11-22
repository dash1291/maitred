# maitred container. Built on the target host (x86_64) by deploy.sh.
FROM node:22-slim

# tini: clean signal handling (SIGTERM -> node)
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /maitred

# deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Chromium for the browser tool, outside any home directory so uid 1000 can run it
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps --only-shell chromium \
    && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*

# app
COPY src ./src
COPY recipes ./recipes

# state lives on a bind mount; created by compose/deploy.sh
ENV NODE_ENV=production
VOLUME /maitred/state
EXPOSE 0

ENTRYPOINT ["/usr/bin/tini", "--"]
# web console = daemon + console in one process (bootstrap+resume inside web.ts)
CMD ["node", "--experimental-strip-types", "src/web.ts"]
