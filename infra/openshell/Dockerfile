# =============================================================================
# OpenZosma Agent Sandbox Image
#
# Runs pi-coding-agent inside an NVIDIA OpenShell sandbox with an HTTP server
# for communication with the orchestrator. Each user gets a persistent sandbox
# built from this image.
#
# Architecture follows NemoClaw's pattern:
# - Multi-stage build (builder + runtime)
# - Immutable config (root-owned) + writable workspace (sandbox-owned)
# - Non-root execution via sandbox user
# - tini as init process for proper signal handling
#
# Uses `pnpm deploy` to produce a self-contained directory with all
# dependencies resolved (no symlinks), which is required because Docker
# COPY does not preserve pnpm's symlinked node_modules structure.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build sandbox-server and produce a deployable bundle
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /build

# Copy workspace config for dependency resolution
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/sandbox-server/package.json packages/sandbox-server/
COPY packages/agents/package.json packages/agents/
COPY packages/logger/package.json packages/logger/
COPY packages/memory/package.json packages/memory/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/logger/ packages/logger/
COPY packages/agents/ packages/agents/
COPY packages/memory/ packages/memory/
COPY packages/sandbox-server/ packages/sandbox-server/

RUN pnpm --filter @openzosma/logger run build
RUN pnpm --filter @openzosma/agents run build
RUN pnpm --filter @openzosma/sandbox-server run build

# Use pnpm deploy to create a self-contained directory with all runtime
# dependencies resolved (no symlinks). This is the standard pnpm approach
# for Docker production builds.
RUN pnpm --filter @openzosma/sandbox-server deploy /deploy --prod --legacy

# Copy built dist into the deploy directory
RUN cp -r packages/sandbox-server/dist /deploy/dist

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:22-slim

# Install runtime dependencies and developer tools.
# iproute2 is required by the OpenShell sandbox supervisor for network namespace creation.
# python3-venv provides virtualenv support for isolated Python environments.
# tree, jq, wget, less, unzip, zip are general-purpose CLI tools the agent can use.
# make + g++ are required for native npm modules that use node-gyp.
# Node.js and npm are already present from the node:22-slim base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    python3-venv \
    tini \
    curl \
    iproute2 \
    tree \
    jq \
    wget \
    less \
    unzip \
    zip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user (OpenShell convention: non-root execution)
# --home is required so homedir() returns a real path; bootstrapPiExtensions()
# writes config files to ~/.pi/ and will crash if home is /nonexistent.
RUN addgroup --system --gid 1001 sandbox && \
    adduser --system --uid 1001 --ingroup sandbox --home /home/sandbox sandbox && \
    mkdir -p /home/sandbox/.pi && \
    chown -R sandbox:sandbox /home/sandbox

WORKDIR /app

# Copy the self-contained deploy bundle (node_modules + dist, no symlinks)
COPY --from=builder /deploy ./

RUN npm install -g @mariozechner/pi-coding-agent

# Copy extension manifest and install script before switching to sandbox user
COPY packages/agents/extensions.json /tmp/extensions.json
COPY infra/openshell/scripts/install-extensions.mjs /tmp/install-extensions.mjs

# Copy pi config (mirrors ~/.pi/ structure) — owned by sandbox
COPY packages/agents/src/pi/.config/ /home/sandbox/.pi/
RUN chown -R sandbox:sandbox /home/sandbox/.pi/

# Copy sandbox policies (immutable, root-owned)
COPY infra/openshell/policies/ ./policies/
RUN chown root:root -R ./policies/ && chmod 444 -R ./policies/

# Create workspace directory (writable, sandbox-owned)
# This is where the user's files, code, and agent data live.
# In per-user persistent sandboxes, this directory persists across sessions.
# /sandbox is the OpenShell writable root where .env is uploaded.
# .knowledge-base is pre-created so the agent prompt doesn't error on ls.
RUN mkdir -p /workspace/.knowledge-base /tmp/agent /sandbox && \
    chown -R sandbox:sandbox /workspace /tmp/agent /sandbox

# Copy entrypoint into /app/ which is already in the policy read_only allowlist.
# Placing it at the filesystem root (/) would be blocked by Landlock.
COPY infra/openshell/scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Pre-install pi extensions from manifest so they are available at runtime
# Must run as root before USER sandbox because `pi install` calls `npm install -g`
# which writes to the root-owned /usr/local/lib/node_modules/ directory.
RUN node /tmp/install-extensions.mjs /tmp/extensions.json

# Switch to sandbox user for runtime
USER sandbox

# HTTP server port for orchestrator communication
EXPOSE 3000

# Use tini as PID 1 for proper signal handling (same as NemoClaw)
ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
