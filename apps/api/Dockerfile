# SAILES API (also serves the widget bundle). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t sailes-api .
FROM public.ecr.aws/docker/library/node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/widget/package.json apps/widget/
RUN pnpm install --frozen-lockfile --filter @sailes/api --filter @sailes/widget
COPY apps/widget apps/widget
COPY apps/api apps/api
RUN pnpm --filter @sailes/widget build && pnpm --filter @sailes/api build
RUN pnpm --filter @sailes/api deploy --prod --legacy /out

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /app/apps/api
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/public ./public
COPY --from=build /repo/apps/widget/dist /app/apps/widget/dist
# Amazon RDS certificate bundle, so database TLS is verified.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
ENV DATABASE_CA_FILE=/app/rds-ca.pem
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/server.js"]
