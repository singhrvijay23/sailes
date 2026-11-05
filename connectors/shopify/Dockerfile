# SAILES Shopify app. Build from the repo root:
#   docker build -f connectors/shopify/Dockerfile -t sailes-shopify .
FROM public.ecr.aws/docker/library/node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY connectors/shopify/package.json connectors/shopify/
RUN pnpm install --frozen-lockfile --filter @sailes/shopify
COPY connectors/shopify connectors/shopify
RUN pnpm --filter @sailes/shopify build
RUN pnpm --filter @sailes/shopify deploy --prod --legacy /out

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production PORT=4100
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/connectors/shopify/dist ./dist
COPY --from=build /repo/connectors/shopify/public ./public
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4100/health || exit 1
CMD ["node", "dist/src/server.js"]
