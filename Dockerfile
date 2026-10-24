# Fit backend container image. Built and smoke-tested by .github/workflows/ci.yml
# (see docs/ci.md). Same shape as money's image: build stage, then a
# production stage with prod dependencies only, running as uid 1000.

FROM node:24-alpine AS builder
WORKDIR /workdir

# Package manifests first, so the dependency layer is cached across source changes
COPY package*.json ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/activity-model/package.json ./packages/activity-model/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY . .
RUN npx nx run @fit/backend:build --skip-nx-cache

FROM node:24-alpine
WORKDIR /workdir
ENV NODE_ENV=production
ENV PORT=4190

COPY package*.json ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/activity-model/package.json ./packages/activity-model/
# Production dependencies only; @fit/activity-model is linked as a workspace
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /workdir/packages/activity-model/dist ./packages/activity-model/dist
COPY --from=builder /workdir/apps/backend/dist ./apps/backend/dist

# The base image's `node` user, by number, so Kubernetes runAsNonRoot can verify it.
# App files stay root-owned and read-only; the only writable path at runtime is /tmp.
USER 1000:1000
EXPOSE 4190
WORKDIR /workdir/apps/backend
CMD ["node", "dist/main.js"]
