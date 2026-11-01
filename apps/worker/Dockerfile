# Build from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:24-slim AS build
RUN npm install -g pnpm@11.24.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@memdot/worker..."
RUN pnpm --filter "@memdot/worker..." build
RUN pnpm --filter @memdot/worker deploy --prod --legacy --config.strictDepBuilds=false /out

FROM node:24-slim
# curl is what Coolify's health check runs inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HEALTH_PORT=8788
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8788
CMD ["node", "--enable-source-maps", "--max-old-space-size=768", "dist/main.mjs"]
