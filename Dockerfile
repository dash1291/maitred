# maitred container. Built on the target host (x86_64) by deploy.sh.
FROM node:22-slim

# tiny init for clean signal handling (SIGTERM -> node)
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /maitred

# deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# app
COPY src ./src
COPY recipes ./recipes
COPY .env.example ./

# state lives on a bind mount; created by compose/deploy.sh
ENV NODE_ENV=production
VOLUME /maitred/state
EXPOSE 0

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/main.ts", "daemon"]
