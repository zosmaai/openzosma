# Architecture

## System Overview

OpenZosma is a self-hosted AI agent platform. The backend is a standalone TypeScript service. Clients (Next.js dashboard, React Native app, WhatsApp bot, Slack bot, external A2A agents) are independent consumers connected via REST, WebSocket, or A2A protocol. Internal services communicate via gRPC.

There are no Next.js API routes in the critical path. The backend owns all business logic.

```
+-----------------------------------------------------------------+
|                         Clients                                  |
|  Web (Next.js)  |  Mobile (RN)  |  Slack  |  WhatsApp  |  A2A  |
+-------------------------------+---------------------------------+
                                |
                                v
+-----------------------------------------------------------------+
|                    API Gateway (Hono)                             |
|                                                                  |
|  REST API          WebSocket Server       A2A Endpoint           |
|  /api/v1/*         /api/v1/sessions/      /.well-known/agent.json|
|                    :id/ws                 /a2a (JSON-RPC 2.0)    |
|                                                                  |
|  Auth middleware (Better Auth)                                    |
|  Rate limiting (configurable)                                    |
|  Request validation                                              |
+-------------------------------+---------------------------------+
                                |
                          gRPC (internal)
                                |
                                v
+-----------------------------------------------------------------+
|                       Orchestrator                                |
|                                                                  |
|  Session Manager        Sandbox Pool        Config Manager       |
|  - create/destroy       - pre-warm          - quotas (optional)  |
|  - state machine        - allocate/release  - rate limits        |
|  - message routing      - health checks     - settings           |
|                                                                  |
|  Event Bus (RabbitMQ)   State Store (Valkey)                     |
|  - webhooks             - active sessions                        |
|  - analytics            - message cache                          |
|  - async tasks          - pub/sub fan-out                        |
+-------------------------------+---------------------------------+
                                |
                    gRPC bidirectional streaming
                                |
              +-----------------+------------------+
              v                 v                  v
+----------------+  +----------------+  +----------------+
|  OpenShell     |  |  OpenShell     |  |  OpenShell     |
|  Sandbox       |  |  Sandbox       |  |  Sandbox       |
|                |  |                |  |                |
|  pi-coding-    |  |  pi-coding-    |  |  pi-coding-    |
|  agent (gRPC)  |  |  agent (gRPC)  |  |  agent (gRPC)  |
+----------------+  +----------------+  +----------------+
```

## Communication Protocols

| Path | Protocol | Purpose |
|---|---|---|
| External clients -> Gateway | REST + WebSocket | Web dashboard, SDK, mobile |
| External agents -> Gateway | A2A (JSON-RPC 2.0 over HTTPS + SSE) | Agent-to-agent |
| Gateway -> Orchestrator | gRPC | Internal service-to-service |
| Orchestrator -> Sandbox | gRPC bidirectional streaming | Agent message routing |
| Channel adapters | Native (Slack Socket Mode, WhatsApp webhooks) | Slack, WhatsApp |

gRPC is used for all internal communication. Benefits over stdin/stdout JSONL:
- Binary protocol (protobuf), lower overhead
- Bidirectional streaming (perfect for agent event streams)
- Strong typing via `.proto` definitions
- Works across network boundaries (not just local K3s exec)

## Components

### API Gateway (`packages/gateway/`)

Single Hono server exposing three external protocols:

**REST API** for standard request-response:
```
POST   /api/v1/sessions              Create session
GET    /api/v1/sessions/:id          Get session status
DELETE /api/v1/sessions/:id          End session
POST   /api/v1/sessions/:id/messages Send message
GET    /api/v1/sessions/:id/messages List messages
GET    /api/v1/sessions/:id/stream   SSE event stream
GET    /api/v1/agents                List available agents
GET    /api/v1/usage                 Usage statistics
```

**WebSocket** for real-time bidirectional communication:
```
ws://host/api/v1/sessions/:id/ws
```
Client sends messages, server pushes `AgentEvent` stream using the existing `ProxyAssistantMessageEvent` wire format from pi-agent (`packages/agent/src/proxy.ts`).

**A2A Protocol** for agent-to-agent interaction:
```
GET  /.well-known/agent.json     Agent Card (capabilities, skills)
POST /a2a                        JSON-RPC 2.0 endpoint
```
Methods: `tasks/send`, `tasks/sendSubscribe` (SSE), `tasks/get`, `tasks/cancel`, `tasks/pushNotification/set`, `tasks/pushNotification/get`.

A2A tasks map 1:1 to OpenZosma sessions.

Internally, the gateway communicates with the orchestrator via gRPC.

### gRPC Definitions (`packages/grpc/`, `proto/`)

Proto definitions for internal services:

```protobuf
// proto/orchestrator.proto
service OrchestratorService {
  rpc CreateSession(CreateSessionRequest) returns (Session);
  rpc EndSession(EndSessionRequest) returns (Empty);
  rpc SendMessage(SendMessageRequest) returns (stream AgentEvent);
  rpc CancelTurn(CancelTurnRequest) returns (Empty);
  rpc GetSession(GetSessionRequest) returns (Session);
  rpc ListActiveSessions(ListActiveSessionsRequest) returns (SessionList);
}

// proto/sandbox.proto
service SandboxAgentService {
  rpc ProcessMessage(stream AgentMessage) returns (stream AgentEvent);
  rpc HealthCheck(Empty) returns (HealthResponse);
}
```

### Orchestrator (`packages/orchestrator/`)

Core business logic layer. Responsibilities:

- **Session lifecycle:** Create, pause, resume, destroy sessions. State machine: `created -> active -> paused -> ended` or `created -> active -> failed`.
- **Sandbox pool:** Maintain pre-warmed sandboxes. Allocate on session creation, release on session end. Health checks and automatic replacement. Pool size is configurable.
- **Message routing:** Accept messages from gateway via gRPC, forward to sandbox via gRPC bidirectional streaming, stream responses back.
- **Configurable quotas:** Optional concurrent session limits, token budgets, rate limits (configured via env vars or settings table).
- **Event emission:** Publish events to RabbitMQ for async consumers (webhooks, analytics).

### Sandbox Manager (`packages/sandbox/`)

Wrapper around NVIDIA OpenShell CLI/API.

**Sandbox lifecycle:**
1. Session created -> Orchestrator requests sandbox from pool
2. OpenShell creates K3s pod with custom Docker image (Node.js + pi-coding-agent)
3. YAML policy applied (filesystem, network, process restrictions)
4. Credentials injected via OpenShell credential provider (env vars, never on filesystem)
5. pi-coding-agent starts with gRPC server listening
6. Orchestrator connects to sandbox gRPC endpoint
7. Session ends -> sandbox destroyed, resources freed

**Policy structure:**
```yaml
filesystem:
  allow_read: ["/workspace", "/tmp"]
  allow_write: ["/workspace", "/tmp"]
  deny: ["/etc/passwd", "/proc", "/sys"]
network:
  allow:
    - host: "api.openai.com"
      methods: ["POST"]
      paths: ["/v1/chat/completions"]
    - host: "api.anthropic.com"
  deny_all_other: true
process:
  allow: ["node", "python3", "git", "npm"]
  deny: ["sudo", "su", "chmod"]
inference:
  provider: "openai"
  model: "gpt-4o"
```

Policies are configurable via the settings. Filesystem and process policies are locked at sandbox creation. Network and inference policies are hot-reloadable.

**Sandbox pool:** Configurable pool size (env var `SANDBOX_POOL_SIZE`, default 2). No per-tier logic in the OSS version.

### Database (`packages/db/`)

PostgreSQL with raw SQL via `pg` driver. Migrations via `node-pg-migrate`.

Core tables:

| Table | Purpose |
|---|---|
| `users` | id, email, name, role, auth_provider_id, created_at |
| `sessions` | id, user_id, agent_config_id, sandbox_id, status, created_at, ended_at |
| `messages` | id, session_id, role, content, tool_calls, tokens_used, created_at |
| `agent_configs` | id, name, model, system_prompt, tools_enabled, skills, created_at |
| `api_keys` | id, name, key_hash, key_prefix, scopes, expires_at, created_at |
| `usage` | id, session_id, tokens_in, tokens_out, cost, model, created_at |
| `connections` | id, name, type, encrypted_credentials, schema_cache, read_only, created_at |
| `settings` | key, value (instance-level configuration) |

### Cache and Pub/Sub (Valkey)

- **Session state:** Active session metadata, sandbox assignments
- **Message cache:** Recent messages for fast retrieval (PostgreSQL is source of truth)
- **Pub/Sub:** Fan-out for SSE and WebSocket connections (multiple gateway instances can serve the same session)
- **Auth tokens:** Session cookies, API key validation cache

### Job Queue (RabbitMQ)

- **Webhook delivery:** Retry with exponential backoff
- **Analytics events:** Usage tracking
- **Async tasks:** Report generation, long-running operations
- **Sandbox lifecycle events:** Creation, health check failures, cleanup

### Auth (`packages/auth/`)

Better Auth with:
- Email/password + OAuth (GitHub, Google)
- API key auth for programmatic access
- RBAC: admin, member
- Session management via Valkey

### A2A Protocol (`packages/a2a/`)

Implementation using `@a2a-js/sdk`:
- Agent Card generation from `agent_configs` table
- Task lifecycle mapping: A2A task -> OpenZosma session
- SSE streaming via `tasks/sendSubscribe`
- Push notifications (webhooks) for async task completion

### Channel Adapters (`packages/adapters/`)

Each adapter translates between a channel's native protocol and the OpenZosma orchestrator (via gRPC or REST).

**Slack** (`packages/adapters/slack/`):
- Based on existing `pi-mom` package in pi-mono
- Socket Mode or HTTP Events API
- Slack threads -> OpenZosma sessions
- File upload support

**WhatsApp** (`packages/adapters/whatsapp/`):
- WhatsApp Business Cloud API
- Webhook receiver for incoming messages
- Phone number + conversation -> session mapping
- Media handling (images, documents)
- Template messages for notifications

### Database Querying

Database querying is NOT a separate skill package. It is a **guardrailed tool** available to the agent inside the sandbox. Connection details are injected via environment variables:

```bash
DB_TYPE=postgresql          # postgresql, mysql, mongodb, clickhouse, bigquery, sqlite
DB_HOST=db.example.com
DB_PORT=5432
DB_NAME=analytics
DB_USER=readonly
DB_PASS=***
# or
DB_CONNECTION_STRING=postgresql://readonly:***@db.example.com:5432/analytics
```

The tool parses SQL before execution and enforces:
- **Read-only:** Only `SELECT`, `WITH...SELECT`, `EXPLAIN` allowed
- **Blocked:** `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`
- **Limits:** `LIMIT` appended if missing, statement timeout enforced
- **MongoDB:** Only `find`, `aggregate`, `countDocuments` allowed

### Report Skill (`packages/skills/reports/`)

Two approaches, both supported:
1. **Template-based:** Agent produces structured JSON -> rendered via React-PDF (PDF) / pptxgenjs (PPTX) / chart.js (charts). Deterministic output. Good for standardized reports.
2. **Agent-generated code:** Agent writes Python (matplotlib, pandas) or JS (chart.js, D3) code -> executed inside sandbox -> output files (PNG, PDF, SVG) returned. Flexible output. Good for ad-hoc analysis.

### Web Dashboard (`apps/web/`)

Next.js app consuming OpenZosma REST + WebSocket APIs. No API routes in the critical path.

Pages:
- `/login`, `/register` -- auth flows
- `/dashboard` -- overview, active sessions, usage stats
- `/chat` -- real-time agent interaction (WebSocket)
- `/sessions` -- session history, replay
- `/agents` -- configure agent personas, tools, models
- `/connections` -- manage database connections
- `/settings` -- instance settings, team management, API keys

## Data Flow

### User sends a message (WebSocket)

```
1. Client -> WebSocket -> Gateway
2. Gateway authenticates, validates
3. Gateway -> gRPC -> Orchestrator.SendMessage(sessionId, message)
4. Orchestrator looks up sandbox for session (Valkey)
5. Orchestrator -> gRPC bidirectional stream -> pi-agent in sandbox
6. pi-agent processes message, calls tools, streams AgentEvents
7. AgentEvents -> gRPC stream -> Orchestrator
8. Orchestrator persists to PostgreSQL, caches in Valkey
9. Orchestrator publishes to Valkey pub/sub
10. Gateway picks up from pub/sub -> pushes to all connected WebSocket clients
```

### A2A task lifecycle

```
1. External agent -> POST /a2a { method: "tasks/sendSubscribe", params: { message } }
2. Gateway parses JSON-RPC, authenticates via Agent Card
3. Gateway creates OpenZosma session (if new task) or routes to existing
4. Orchestrator processes message through sandbox (gRPC)
5. AgentEvents streamed back as SSE (Content-Type: text/event-stream)
6. Task status transitions: submitted -> working -> completed/failed
7. If push notification configured, webhook fired on completion
```

## Pi-Mono Integration

OpenZosma depends on pi-mono packages via npm:
- `pi-ai` -- LLM abstraction (streaming, multi-provider)
- `pi-agent-core` -- Agent class, event system, tool loop
- `pi-coding-agent` -- AgentSession, coding tools, session management

Key abstractions used:
- `StreamFn` (`agent/src/types.ts:23`) -- pluggable LLM transport
- `AgentEvent` (`agent/src/types.ts:199-214`) -- agent lifecycle events
- `ProxyAssistantMessageEvent` (`agent/src/proxy.ts:36-57`) -- bandwidth-optimized wire format
- `EventStream<T, R>` (`ai/src/utils/event-stream.ts`) -- generic async iterable
- RPC mode (stdin/stdout JSONL) -- already exists in pi-coding-agent, will be extended with gRPC

Phase 1 refactors pi-coding-agent to remove 7 global state issues that block multi-instance usage. See [docs/PHASE-1-MULTITENANT.md](./docs/PHASE-1-MULTITENANT.md) for details.


