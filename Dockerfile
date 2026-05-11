# getfluxo.io - Docker Build Configuration
# Copyright (c) 2026 getfluxo.io
# License: PROPRIETARY

FROM node:24-alpine AS builder
WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml* ./
RUN npm i -g pnpm@10 && pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm run build

FROM node:24-alpine AS runtime
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/dist ./dist
COPY package.json pnpm-lock.yaml* ./
RUN npm i -g pnpm@10 && pnpm install --prod --frozen-lockfile
ENV NODE_ENV=production
EXPOSE 3000
# Expose prometheus metrics port too (same process)
EXPOSE 9100
CMD ["node","dist/main.js"]
