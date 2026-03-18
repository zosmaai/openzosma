# =============================================================================
# NemoClaw sandbox image
# Runs pi-coding-agent inside an OpenShell sandbox with gRPC server.
# Built and managed by the orchestrator's sandbox pool.
# =============================================================================

FROM node:22-slim

# Install minimal runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user (OpenShell convention: non-root execution)
RUN addgroup --system --gid 1001 sandbox && \
    adduser --system --uid 1001 --ingroup sandbox sandbox

WORKDIR /app

# Install NemoClaw and agent dependencies
# These will be populated when pi-coding-agent packages are published
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate && \
    pnpm install --frozen-lockfile --prod

# Copy agent code and gRPC server
COPY dist/ ./dist/

# Copy sandbox policies
COPY policies/ ./policies/

# Create workspace directory for agent file operations
RUN mkdir -p /workspace /tmp/agent && \
    chown -R sandbox:sandbox /workspace /tmp/agent /app

USER sandbox

# gRPC server port for orchestrator communication
EXPOSE 50052

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
