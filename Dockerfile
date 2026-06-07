# getfluxo.io - Docker Build Configuration
# Copyright (c) 2026 getfluxo.io
# License: PROPRIETARY

FROM node:22.22.3-alpine AS builder
WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/fengine/package.json packages/fengine/package.json
RUN npm i -g pnpm@10.33.0 && pnpm install --filter @getfluxo/fengine... --frozen-lockfile --prod=false
COPY packages/fengine packages/fengine
RUN pnpm --filter @getfluxo/fengine build

FROM node:22.22.3-alpine AS runtime
WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/fengine/package.json packages/fengine/package.json
RUN npm i -g pnpm@10.33.0 && pnpm install --filter @getfluxo/fengine --prod --frozen-lockfile
COPY --from=builder /usr/src/app/packages/fengine/dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/main.js"]
