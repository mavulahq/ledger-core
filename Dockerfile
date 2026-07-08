# mavula.io - Docker Build Configuration
# Copyright (c) 2026 mavula.io
# SPDX-License-Identifier: AGPL-3.0-only

FROM node:22.22.3-alpine AS dev
WORKDIR /usr/src/app
RUN apk add --no-cache openssl
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages packages
RUN npm i -g pnpm@10.33.0 && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --filter @mavula/ledger-core... --frozen-lockfile --ignore-scripts && \
    pnpm --filter @mavula/ledger-core prisma:generate

FROM node:22.22.3-alpine AS builder
WORKDIR /usr/src/app
RUN apk add --no-cache openssl
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ledger-core/package.json packages/ledger-core/package.json
RUN npm i -g pnpm@10.33.0 && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --filter @mavula/ledger-core... --frozen-lockfile --prod=false --ignore-scripts
COPY packages/ledger-core packages/ledger-core
RUN pnpm --filter @mavula/ledger-core build

FROM node:22.22.3-alpine AS runtime
WORKDIR /usr/src/app
RUN apk add --no-cache openssl
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ledger-core/package.json packages/ledger-core/package.json
RUN npm i -g pnpm@10.33.0 && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --filter @mavula/ledger-core --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /usr/src/app/packages/ledger-core/dist ./dist
COPY --from=builder /usr/src/app/node_modules/.pnpm/@prisma+client@5.7.0_prisma@5.7.0/node_modules/.prisma /usr/src/app/node_modules/.pnpm/@prisma+client@5.7.0_prisma@5.7.0/node_modules/.prisma
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/main.js"]
