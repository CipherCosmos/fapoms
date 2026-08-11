# Multi-stage production build for FAPOMS Frontend React Web App
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/shared/package*.json packages/shared/
COPY packages/frontend/package*.json packages/frontend/

RUN npm ci --legacy-peer-deps

COPY packages/shared packages/shared
COPY packages/frontend packages/frontend

RUN npm run build:frontend

FROM nginx:alpine AS runner
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
