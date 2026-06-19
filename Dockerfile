# getfluxo.io - Docker Build Configuration
# Copyright (c) 2026 getfluxo.io
# License: PROPRIETARY

FROM node:22.22.3-alpine AS builder
WORKDIR /usr/src/app
RUN apk add --no-cache openssl
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/fengine/package.json packages/fengine/package.json
RUN --mount=type=cache,id=getfluxo-pnpm-store,target=/pnpm/store,sharing=locked \
    npm i -g pnpm@10.33.0 && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --filter @getfluxo/fengine... --frozen-lockfile --prod=false --ignore-scripts
COPY packages/fengine packages/fengine
RUN pnpm --filter @getfluxo/fengine prisma:generate && pnpm --filter @getfluxo/fengine build

FROM node:22.22.3-alpine AS runtime
WORKDIR /usr/src/app
RUN apk add --no-cache openssl
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/fengine/package.json packages/fengine/package.json
RUN --mount=type=cache,id=getfluxo-pnpm-store,target=/pnpm/store,sharing=locked \
    npm i -g pnpm@10.33.0 && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --filter @getfluxo/fengine --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /usr/src/app/packages/fengine/dist ./dist
COPY --from=builder /usr/src/app/node_modules/.pnpm/@prisma+client@5.7.0_prisma@5.7.0/node_modules/.prisma /usr/src/app/node_modules/.pnpm/@prisma+client@5.7.0_prisma@5.7.0/node_modules/.prisma
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/main.js"]
