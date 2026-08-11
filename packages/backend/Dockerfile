# Multi-stage production build for FAPOMS NestJS Backend
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/shared/package*.json packages/shared/
COPY packages/backend/package*.json packages/backend/

RUN npm ci --legacy-peer-deps

COPY packages/shared packages/shared
COPY packages/backend packages/backend

RUN npm run build:backend

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY packages/shared/package*.json packages/shared/
COPY packages/backend/package*.json packages/backend/

RUN npm ci --only=production --legacy-peer-deps

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/backend/dist packages/backend/dist

EXPOSE 3000

CMD ["node", "packages/backend/dist/main.js"]
