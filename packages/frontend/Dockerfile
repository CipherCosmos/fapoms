# Multi-stage production build for FAPOMS Frontend React Web App
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/shared/package*.json packages/shared/
COPY packages/frontend/package*.json packages/frontend/

RUN npm ci --legacy-peer-deps

COPY packages/shared packages/shared
COPY packages/frontend packages/frontend

# Build the shared package first — the other two import it.
#
# This step was missing from both production Dockerfiles, and the images therefore could not be
# built at all: `@fapoms/shared` was COPY'd as SOURCE, never compiled, so nothing produced the
# `dist/` and the type declarations that `import { ... } from '@fapoms/shared'` resolves to. The
# frontend build failed with "Cannot find module '@fapoms/shared'" across ~40 files.
#
# It passed on a developer's machine because `packages/shared/dist` was already sitting there
# from an earlier local build. A clean checkout — which is what any CI or new machine is — had
# nothing to resolve against.
RUN npm run build:shared
RUN npm run build:frontend

FROM nginx:alpine AS runner
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html
# SPA routing. Without this, stock nginx 404s on every route except "/" — any refresh, bookmark
# or shared link lands on a Not Found page. See the file for the full explanation.
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
