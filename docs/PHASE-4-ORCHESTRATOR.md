# Phase 4: Orchestrator + OpenShell Sandbox Integration

**Duration:** 1.5 weeks
**Priority:** P0
**Depends on:** Phase 3 (gateway), Phase 1 (multi-instance pi-agent)

## Goal

Build the orchestrator that manages session lifecycle and integrates with NVIDIA OpenShell for per-session sandboxing. This is the core of the platform -- it connects the gateway to isolated agent instances via gRPC.

## Orchestrator (`packages/orchestrator/`)

### Responsibilities

1. **Session lifecycle** -- create, activate, pause, resume, end, fail
2. **Sandbox allocation** -- request from pool, assign to session, release on end
3. **Message routing** -- gateway -> gRPC -> orchestrator -> gRPC bidirectional stream -> sandbox -> back
4. **Configurable quotas** -- optional concurrent session limits, token budgets (configured via `settings` table or env vars)
5. **Event emission** -- publish to RabbitMQ for async consumers

### gRPC Server

The orchestrator exposes a gRPC server that the gateway connects to:

```typescript
import { Server, ServerCredentials } from "@grpc/grpc-js"
import { OrchestratorServiceService } from "@openzosma/grpc"

const server = new Server()

server.addService(OrchestratorServiceService, {
  createSession: async (call, callback) => {
    const { userId, agentConfigId, metadata } = call.request
    const session = await sessionManager.create(userId, agentConfigId, metadata)
    callback(null, session)
  },

  sendMessage: async (call) => {
    const { sessionId, content } = call.request
    // Returns a server-streaming response
    const events = sessionManager.sendMessage(sessionId, content)
    for await (const event of events) {
      call.write(event)
    }
    call.end()
  },

  endSession: async (call, callback) => {
    await sessionManager.end(call.request.sessionId)
    callback(null, {})
  },

  cancelTurn: async (call, callback) => {
    await sessionManager.cancelTurn(call.request.sessionId)
    callback(null, {})
  },

  getSession: async (call, callback) => {
    const session = await sessionManager.get(call.request.sessionId)
    callback(null, session)
  },

  listActiveSessions: async (call, callback) => {
    const sessions = await sessionManager.listActive()
    callback(null, { sessions })
  },
})

server.bindAsync(
  process.env.GRPC_LISTEN ?? "0.0.0.0:50051",
  ServerCredentials.createInsecure(),
  () => server.start(),
)
```

### Session State Machine

```
created ──> active ──> paused ──> active (resume)
                │                    │
                ├──> ended           ├──> ended
                └──> failed          └──> failed
```

States:
- **created** -- session record exists, sandbox being allocated
- **active** -- sandbox running, accepting messages
- **paused** -- sandbox preserved but not accepting messages (idle timeout)
- **ended** -- session completed normally, sandbox destroyed
- **failed** -- sandbox crashed or unrecoverable error, sandbox destroyed

### Core Interface

```typescript
interface SessionManager {
  // Session lifecycle
  create(userId: string, agentConfigId?: string, metadata?: Record<string, string>): Promise<Session>
  end(sessionId: string): Promise<void>

  // Messaging (gRPC bidirectional streaming to sandbox)
  sendMessage(sessionId: string, content: string): AsyncIterable<AgentEvent>
  cancelTurn(sessionId: string): Promise<void>

  // Status
  get(sessionId: string): Promise<Session | null>
  listActive(): Promise<Session[]>

  // Admin
  forceEnd(sessionId: string, reason: string): Promise<void>
}
```

### Message Flow (Detailed)

```
1. Gateway calls orchestrator.SendMessage(sessionId, content) via gRPC
2. Orchestrator validates session is active
3. Orchestrator checks configurable quotas (tokens remaining, if configured)
4. Orchestrator looks up sandbox assignment in Valkey
5. Orchestrator writes message to sandbox via gRPC bidirectional stream
6. pi-coding-agent in sandbox processes message, streams AgentEvents back via gRPC
7. For each event:
   a. Publish to Valkey pub/sub (session:{sessionId} channel)
   b. Accumulate for persistence
   c. Write to gRPC server-stream (back to gateway)
8. On turn_end:
   a. Persist messages to PostgreSQL
   b. Update usage counters
   c. Publish usage event to RabbitMQ
```

### Configurable Quotas

Quotas are read from the `settings` table or env vars. They are optional and can be disabled. There is no per-tenant tier logic in the OSS version.

```typescript
interface InstanceLimits {
  maxConcurrentSessions: number  // from settings table, default 10
  maxSessionDuration: number     // seconds, default 3600
  maxTurnsPerSession: number     // default 100
  maxTokensPerTurn: number       // default unlimited
}

async function checkQuota(): Promise<void> {
  const activeSessions = await getActiveSessionCount()  // Valkey
  const limits = await getSettings()

  if (activeSessions >= limits.maxConcurrentSessions) {
    throw new QuotaExceededError("concurrent_sessions")
  }
}
```

## Sandbox Manager (`packages/sandbox/`)

### OpenShell Integration

NVIDIA OpenShell provides:
- K3s Kubernetes cluster inside a Docker container
- CLI: `openshell sandbox create|connect|delete`
- Declarative YAML policies
- Credential injection via env vars

### Sandbox Lifecycle

```typescript
interface SandboxManager {
  // Pool management
  warmPool(count: number): Promise<void>

  // Allocation
  allocate(config: SandboxConfig): Promise<Sandbox>
  release(sandboxId: string): Promise<void>

  // gRPC connection to sandbox agent
  connect(sandboxId: string): SandboxAgentClient

  // Health
  healthCheck(sandboxId: string): Promise<boolean>

  // Policy
  setPolicy(sandboxId: string, policy: SandboxPolicy): Promise<void>
}
```

### Sandbox Creation with gRPC

```typescript
async function createSandbox(config: SandboxConfig): Promise<Sandbox> {
  // 1. Create OpenShell sandbox with custom image
  const sandbox = await openshell.sandbox.create({
    image: "openzosma/agent-sandbox:latest",
    policy: buildPolicy(config),
    credentials: buildCredentials(config),
  })

  // 2. Start pi-coding-agent with gRPC server inside the sandbox
  const proc = await openshell.sandbox.exec(sandbox.id, {
    command: ["node", "pi-coding-agent", "--grpc", "--port", "50052"],
    stdin: false,  // not needed, communication is via gRPC
    stdout: true,  // for startup logs
    stderr: true,
  })

  // 3. Wait for gRPC server ready signal
  const ready = await waitForGrpcReady(sandbox.id, 50052, { timeout: 10000 })
  if (!ready) throw new Error("Sandbox gRPC server failed to start")

  // 4. Create gRPC client connection to sandbox
  const client = createSandboxClient(`${sandbox.internalIp}:50052`)

  return { id: sandbox.id, client }
}
```

### Custom Sandbox Docker Image

```dockerfile
# infra/openshell/Dockerfile
FROM node:20-slim

# Install pi-coding-agent
RUN npm install -g pi-coding-agent

# Install optional runtimes for skills
RUN apt-get update && apt-get install -y \
    python3 python3-pip git \
    && rm -rf /var/lib/apt/lists/*

# Python packages for report generation
RUN pip3 install matplotlib pandas numpy

# Create workspace directory
RUN mkdir -p /workspace
WORKDIR /workspace

# Entry point (overridden by OpenShell exec)
CMD ["node", "pi-coding-agent", "--grpc", "--port", "50052"]
```

### Policy Generation

```typescript
function buildPolicy(config: SandboxConfig): SandboxPolicy {
  return {
    filesystem: {
      allow_read: ["/workspace", "/tmp", "/usr/local/lib/node_modules"],
      allow_write: ["/workspace", "/tmp"],
      deny: ["/etc/shadow", "/proc/kcore", "/sys"],
    },
    network: {
      allow: [
        // LLM API access (via OpenShell privacy router)
        ...config.allowedProviders.map(p => ({
          host: getProviderHost(p),
          methods: ["POST"],
          paths: getProviderPaths(p),
        })),
        // Database access (if database connections configured)
        ...config.allowedDatabases.map(db => ({
          host: db.host,
          port: db.port,
        })),
        // gRPC communication back to orchestrator
        { host: "orchestrator", port: 50051 },
      ],
      deny_all_other: true,
    },
    process: {
      allow: ["node", "npm", "npx", "python3", "pip3", "git", "bash", "sh"],
      deny: ["sudo", "su", "chmod", "chown", "mount"],
    },
    inference: config.inferencePolicy,
  }
}
```

### Credential Injection

```typescript
function buildCredentials(config: SandboxConfig): Credentials {
  // OpenShell injects these as env vars, never written to filesystem
  return {
    providers: [
      {
        name: "llm",
        env: {
          OPENAI_API_KEY: config.openaiKey,
          ANTHROPIC_API_KEY: config.anthropicKey,
          // ... other provider keys
        },
      },
    ],
  }
}
```

## Sandbox Pool

### Pre-Warming

Keep N sandboxes ready to reduce cold start latency. Pool size is configurable via `settings` table or `SANDBOX_POOL_SIZE` env var (default 2).

### Pool Management

```typescript
class SandboxPool {
  private available: Sandbox[] = []
  private poolSize: number

  constructor(poolSize: number = 2) {
    this.poolSize = poolSize
  }

  async warm(): Promise<void> {
    const needed = this.poolSize - this.available.length
    const sandboxes = await Promise.all(
      Array.from({ length: needed }, () => createSandbox(getDefaultConfig()))
    )
    this.available.push(...sandboxes)
  }

  async allocate(config: SandboxConfig): Promise<Sandbox> {
    if (this.available.length > 0) {
      const sandbox = this.available.pop()!
      // Apply session-specific policy (network policy is hot-reloadable)
      await this.applyPolicy(sandbox, config)
      return sandbox
    }

    // Pool empty, create on-demand (slower)
    return createSandbox(config)
  }

  async release(sandbox: Sandbox): Promise<void> {
    // Destroy sandbox (don't reuse for security)
    await openshell.sandbox.delete(sandbox.id)
    // Trigger background replenishment
    this.replenish()
  }

  private async replenish(): Promise<void> {
    if (this.available.length < this.poolSize) {
      const sandbox = await createSandbox(getDefaultConfig())
      this.available.push(sandbox)
    }
  }
}
```

### Health Checks

Background process runs every 30 seconds:
1. Ping each pooled sandbox via gRPC `HealthCheck` call
2. Replace unhealthy sandboxes
3. Log sandbox metrics (CPU, memory, uptime)

## RabbitMQ Events

### Exchanges and Queues

```
Exchange: openzosma.events (topic)
  ├── session.created   -> analytics queue
  ├── session.ended     -> analytics queue, cleanup queue
  ├── session.failed    -> alerts queue, cleanup queue
  ├── message.completed -> analytics queue, webhook queue
  ├── usage.recorded    -> analytics queue
  └── sandbox.unhealthy -> alerts queue
```

### Webhook Delivery

When push notifications are configured (A2A or custom webhooks):
1. Event published to `webhook` queue
2. Worker picks up event, resolves webhook URL
3. POST to webhook URL with event payload
4. Retry with exponential backoff (3 attempts, 1s/5s/30s)
5. On permanent failure, log warning

## Deliverables

1. `packages/orchestrator/` with gRPC server, session lifecycle, message routing, configurable quotas
2. `packages/sandbox/` with OpenShell wrapper, gRPC client, pool management, policy generation
3. RabbitMQ event publishing
4. Sandbox Docker image (`infra/openshell/Dockerfile`)
5. Default sandbox policies (`infra/openshell/policies/`)
6. Integration tests (orchestrator + sandbox, using Docker)
7. Health check system for sandbox pool (gRPC-based)
