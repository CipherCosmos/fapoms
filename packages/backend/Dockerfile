# Multi-stage production build for FAPOMS NestJS Backend
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/shared/package*.json packages/shared/
COPY packages/backend/package*.json packages/backend/

RUN npm ci --legacy-peer-deps

COPY packages/shared packages/shared
COPY packages/backend packages/backend

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
