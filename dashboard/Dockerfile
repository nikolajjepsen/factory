# Kontrolrummet. Bygges fra repo-roden: docker compose build dashboard
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY dashboard/package.json dashboard/
# Only the dashboard and what it needs. No install scripts: the daemon's native modules
# (better-sqlite3) are not built, and esbuild gets its binary as an optional package.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@ai-factory/dashboard..."
COPY packages/protocol packages/protocol
COPY dashboard dashboard
RUN pnpm --filter @ai-factory/dashboard build

FROM node:22-slim
ENV NODE_ENV=production PORT=80
WORKDIR /app
# The build bundles every dependency, so the image holds only dist/.
COPY --from=build /repo/dashboard/dist ./
USER node
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]
