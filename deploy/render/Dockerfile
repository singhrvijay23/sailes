# Single-service TEST deployment (Render free plan): the API also serves the console as static files,
# so one free web service and one database are enough. Production uses apps/*/Dockerfile on AWS.
FROM public.ecr.aws/docker/library/node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/widget/package.json apps/widget/
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile
COPY apps apps
RUN pnpm --filter @sailes/widget build \
 && pnpm --filter @sailes/api build \
 && CONSOLE_EXPORT=1 NEXT_PUBLIC_API_URL= NEXT_TELEMETRY_DISABLED=1 pnpm --filter @sailes/console build
RUN pnpm --filter @sailes/api deploy --prod --legacy /out

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production PORT=10000 CONSOLE_DIR=/app/apps/console/out INLINE_JOBS=true RUN_WORKERS=false ALLOW_PLAN_SWITCH=true
WORKDIR /app/apps/api
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/public ./public
COPY --from=build /repo/apps/widget/dist /app/apps/widget/dist
COPY --from=build /repo/apps/console/out /app/apps/console/out
USER node
EXPOSE 10000
CMD ["node", "dist/server.js"]
