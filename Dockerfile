# =============================================================================
# Multi-stage production Dockerfile
# Build targets: gateway, orchestrator
# Usage:
#   docker build --target gateway -t openzosma-gateway .
#   docker build --target orchestrator -t openzosma-orchestrator .
# =============================================================================

# ---------------------------------------------------------------------------
# Stage: base -- shared Node.js + pnpm setup
# ---------------------------------------------------------------------------
FROM node:22-slim AS base

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# Stage: deps -- install production dependencies
# ---------------------------------------------------------------------------
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/grpc/package.json packages/grpc/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/a2a/package.json packages/a2a/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/adapters/slack/package.json packages/adapters/slack/package.json
COPY packages/adapters/whatsapp/package.json packages/adapters/whatsapp/package.json
COPY packages/skills/reports/package.json packages/skills/reports/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage: builder -- compile TypeScript
# ---------------------------------------------------------------------------
FROM deps AS builder

COPY . .
RUN pnpm run build

# ---------------------------------------------------------------------------
# Stage: gateway -- API Gateway (Hono)
# ---------------------------------------------------------------------------
FROM base AS gateway

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 openzosma && \
    adduser --system --uid 1001 --ingroup openzosma openzosma

COPY --from=builder --chown=openzosma:openzosma /app/node_modules ./node_modules
COPY --from=builder --chown=openzosma:openzosma /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/grpc/dist ./packages/grpc/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/grpc/package.json ./packages/grpc/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/a2a/dist ./packages/a2a/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/a2a/package.json ./packages/a2a/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/adapters/slack/dist ./packages/adapters/slack/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/adapters/slack/package.json ./packages/adapters/slack/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/adapters/whatsapp/dist ./packages/adapters/whatsapp/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/adapters/whatsapp/package.json ./packages/adapters/whatsapp/package.json
COPY --from=builder --chown=openzosma:openzosma /app/package.json ./package.json

USER openzosma

EXPOSE 4000

ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/gateway/dist/index.js"]

# ---------------------------------------------------------------------------
# Stage: orchestrator -- Session lifecycle + sandbox pool (gRPC)
# ---------------------------------------------------------------------------
FROM base AS orchestrator

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 openzosma && \
    adduser --system --uid 1001 --ingroup openzosma openzosma

COPY --from=builder --chown=openzosma:openzosma /app/node_modules ./node_modules
COPY --from=builder --chown=openzosma:openzosma /app/packages/orchestrator/dist ./packages/orchestrator/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/orchestrator/package.json ./packages/orchestrator/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/grpc/dist ./packages/grpc/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/grpc/package.json ./packages/grpc/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/sandbox/dist ./packages/sandbox/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/sandbox/package.json ./packages/sandbox/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder --chown=openzosma:openzosma /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder --chown=openzosma:openzosma /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=builder --chown=openzosma:openzosma /app/package.json ./package.json

USER openzosma

EXPOSE 50051

ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/orchestrator/dist/index.js"]
