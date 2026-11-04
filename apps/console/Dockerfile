# SAILES merchant console. Build from the repo root:
#   docker build -f apps/console/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t sailes-console .
FROM public.ecr.aws/docker/library/node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile --filter @sailes/console
COPY apps/console apps/console
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN test -n "$NEXT_PUBLIC_API_URL" && pnpm --filter @sailes/console build

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /repo/apps/console/.next/standalone ./
COPY --from=build /repo/apps/console/.next/static ./apps/console/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/console/server.js"]
