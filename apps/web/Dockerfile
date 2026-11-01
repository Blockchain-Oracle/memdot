# Build from the repo root: docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=... .
FROM node:24-slim AS build
RUN npm install -g pnpm@11.24.0
# Public configuration, inlined into the browser bundle at build time.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_DOCS_URL
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@memdot/web..."
RUN pnpm --filter "@memdot/web..." build

FROM node:24-slim
# curl is what Coolify's health check runs inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
