# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:24-slim AS build
RUN npm install -g pnpm@11.24.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@memdot/api..."
RUN pnpm --filter "@memdot/api..." build
RUN pnpm --filter @memdot/api deploy --prod --legacy --config.strictDepBuilds=false /out

FROM node:24-slim
# curl is what Coolify's health check runs inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787 GATEWAY_CACHE_DIR=/data/gateway
WORKDIR /app
COPY --from=build /out ./
# A volume mounted here on first start inherits this ownership.
RUN mkdir -p /data/gateway && chown -R node:node /data
USER node
EXPOSE 8787
CMD ["node", "--enable-source-maps", "--max-old-space-size=768", "dist/main.mjs"]
