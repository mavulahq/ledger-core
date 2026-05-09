FROM node:20-alpine AS builder
WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml* ./
RUN npm i -g pnpm@8 && pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm run build

FROM node:20-alpine AS runtime
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/dist ./dist
COPY package.json pnpm-lock.yaml* ./
RUN npm i -g pnpm@8 && pnpm install --prod --frozen-lockfile
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/main.js"]
