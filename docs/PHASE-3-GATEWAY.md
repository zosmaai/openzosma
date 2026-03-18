# Phase 3: API Gateway + A2A Server

**Duration:** 1 week
**Priority:** P0
**Depends on:** Phase 2 (monorepo, DB, auth, gRPC)

## Goal

Build a single Hono HTTP server that exposes REST, WebSocket, and A2A protocol endpoints. This is the only external-facing service. All client communication goes through the gateway. Internally, the gateway communicates with the orchestrator via gRPC.

## Technology

- **Hono** -- lightweight, fast, runs on Node.js (and Bun/Deno/Cloudflare if needed later)
- **@a2a-js/sdk** -- Google's official A2A JavaScript SDK
- **ws** (or Hono's built-in WebSocket) -- WebSocket support
- **@grpc/grpc-js** -- gRPC client for orchestrator communication
- **Valkey pub/sub** -- fan-out for SSE and WebSocket connections across gateway instances

## REST API

### Session Endpoints

```
POST   /api/v1/sessions
  Body: { agentConfigId?, message? }
  Returns: { sessionId, status }

GET    /api/v1/sessions/:id
  Returns: { id, status, createdAt, messageCount }

DELETE /api/v1/sessions/:id
  Returns: { ok: true }

POST   /api/v1/sessions/:id/messages
  Body: { content, attachments? }
  Returns: { messageId }

GET    /api/v1/sessions/:id/messages
  Query: ?limit=50&before=<messageId>
  Returns: { messages: [...] }

GET    /api/v1/sessions/:id/stream
  Returns: SSE stream of AgentEvents
  Content-Type: text/event-stream
```

### Agent Endpoints

```
GET    /api/v1/agents
  Returns: { agents: [{ id, name, description, model, skills }] }

GET    /api/v1/agents/:id
  Returns: agent config details
```

### Usage Endpoints

```
GET    /api/v1/usage
  Query: ?from=<date>&to=<date>
  Returns: { tokensIn, tokensOut, cost, sessions }
```

### Auth Endpoints

Better Auth handles its own routes:
```
POST   /api/auth/sign-up/email
POST   /api/auth/sign-in/email
POST   /api/auth/sign-in/social
POST   /api/auth/sign-out
GET    /api/auth/session
```

API key management:
```
POST   /api/v1/api-keys
  Body: { name, scopes?, expiresAt? }
  Returns: { id, key }  (key shown once)

GET    /api/v1/api-keys
  Returns: { keys: [{ id, name, keyPrefix, scopes, lastUsedAt }] }

DELETE /api/v1/api-keys/:id
```

## WebSocket API

```
ws://host/api/v1/sessions/:id/ws
```

### Client -> Server Messages

```json
{ "type": "message", "content": "Hello", "attachments": [] }
{ "type": "cancel" }
{ "type": "ping" }
```

### Server -> Client Messages

Uses the existing `ProxyAssistantMessageEvent` wire format from pi-agent (`packages/agent/src/proxy.ts:36-57`):

```json
{ "type": "agent_start" }
{ "type": "turn_start" }
{ "type": "message_start", "id": "msg_1" }
{ "type": "message_update", "text": "Hello" }
{ "type": "tool_execution_start", "name": "bash", "input": "ls" }
{ "type": "tool_execution_end", "name": "bash", "output": "..." }
{ "type": "message_end" }
{ "type": "turn_end" }
{ "type": "agent_end" }
{ "type": "pong" }
{ "type": "error", "message": "..." }
```

### Connection Lifecycle

1. Client connects with auth token (cookie or `Authorization` header)
2. Gateway validates auth and resolves session
3. Gateway subscribes to Valkey pub/sub channel `session:{sessionId}`
4. Messages from client -> forwarded to orchestrator via gRPC `SendMessage` call
5. Events from orchestrator -> published to Valkey -> fanned out to all connected WebSocket clients
6. Connection closes -> unsubscribe from pub/sub

## gRPC Client

The gateway creates a gRPC client to communicate with the orchestrator:

```typescript
import { createChannel, createClient } from "@grpc/grpc-js"
import { OrchestratorServiceClient } from "@openzosma/grpc"

const channel = createChannel(process.env.ORCHESTRATOR_GRPC_URL ?? "localhost:50051")
const orchestrator = createClient(OrchestratorServiceClient, channel)

// Session creation
app.post("/api/v1/sessions", async (c) => {
  const { agentConfigId, message } = await c.req.json()
  const userId = c.get("userId")

  const session = await orchestrator.createSession({
    userId,
    agentConfigId,
    metadata: {},
  })

  // If initial message provided, send it
  if (message) {
    // Start streaming in background, client can connect via WS/SSE
    orchestrator.sendMessage({ sessionId: session.id, content: message })
  }

  return c.json({ sessionId: session.id, status: session.status })
})

// Message sending with SSE streaming
app.get("/api/v1/sessions/:id/stream", async (c) => {
  const sessionId = c.req.param("id")

  return streamSSE(c, async (stream) => {
    // Subscribe to Valkey pub/sub for this session's events
    const subscriber = valkey.duplicate()
    await subscriber.subscribe(`session:${sessionId}`)

    subscriber.on("message", (channel, message) => {
      const event = JSON.parse(message)
      stream.writeSSE({ data: JSON.stringify(event) })
    })

    // Clean up on disconnect
    stream.onAbort(() => {
      subscriber.unsubscribe(`session:${sessionId}`)
      subscriber.quit()
    })
  })
})
```

## A2A Protocol

### Agent Card

```
GET /.well-known/agent.json
```

Returns per the A2A spec. The Agent Card reflects the instance's configured agent capabilities:

```json
{
  "name": "OpenZosma Agent",
  "description": "AI coding agent platform",
  "url": "https://api.openzosma.dev/a2a",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true
  },
  "skills": [
    {
      "id": "coding",
      "name": "Coding Assistant",
      "description": "Read, write, and edit code. Execute commands. Debug issues."
    },
    {
      "id": "database",
      "name": "Database Querying",
      "description": "Query PostgreSQL, MySQL, MongoDB, ClickHouse, BigQuery, SQLite databases."
    },
    {
      "id": "reports",
      "name": "Report Generation",
      "description": "Generate PDF reports, PPTX presentations, and data visualizations."
    }
  ],
  "authentication": {
    "schemes": ["bearer"]
  }
}
```

The Agent Card is generated from the `agent_configs` and `settings` tables. Skills listed are those enabled on at least one agent config.

### JSON-RPC 2.0 Endpoint

```
POST /a2a
Content-Type: application/json

{ "jsonrpc": "2.0", "method": "tasks/send", "id": "1", "params": { ... } }
```

### Methods

**`tasks/send`** -- Send a message and get the final result:
```json
{
  "method": "tasks/send",
  "params": {
    "id": "task-123",
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "Fix the bug in auth.ts" }]
    }
  }
}
```

**`tasks/sendSubscribe`** -- Send a message and stream updates via SSE:
```json
{
  "method": "tasks/sendSubscribe",
  "params": {
    "id": "task-123",
    "message": { "role": "user", "parts": [{ "type": "text", "text": "..." }] }
  }
}
```
Response: SSE stream with task status updates and message artifacts.

**`tasks/get`** -- Get current task status:
```json
{
  "method": "tasks/get",
  "params": { "id": "task-123" }
}
```

**`tasks/cancel`** -- Cancel a running task:
```json
{
  "method": "tasks/cancel",
  "params": { "id": "task-123" }
}
```

**`tasks/pushNotification/set`** -- Register webhook for task updates:
```json
{
  "method": "tasks/pushNotification/set",
  "params": {
    "id": "task-123",
    "pushNotificationConfig": {
      "url": "https://example.com/webhook",
      "authentication": { "schemes": ["bearer"], "credentials": "token-xyz" }
    }
  }
}
```

### A2A -> OpenZosma Mapping

| A2A Concept | OpenZosma Concept |
|---|---|
| Task | Session |
| Task ID | Session ID |
| Message (with parts) | Session message |
| Artifact | Tool output / generated file |
| Task status (submitted/working/completed/failed) | Session status (created/active/ended/failed) |

## Middleware Stack

```typescript
const app = new Hono()

// Global middleware
app.use("*", cors())
app.use("*", requestId())
app.use("*", logger())

// Rate limiting (configurable via settings table)
app.use("/api/*", rateLimiter())

// Auth: session or API key
app.use("/api/v1/*", authMiddleware())

// Routes
app.route("/api/auth", authRoutes)
app.route("/api/v1/sessions", sessionRoutes)
app.route("/api/v1/agents", agentRoutes)
app.route("/api/v1/usage", usageRoutes)
app.route("/api/v1/api-keys", apiKeyRoutes)
app.route("/a2a", a2aRoutes)
app.get("/.well-known/agent.json", agentCardHandler)
```

No tenant resolution middleware. Auth resolves the user, and the user belongs to this instance.

## Error Handling

Standardized error responses:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session abc-123 not found",
    "status": 404
  }
}
```

Error codes: `AUTH_REQUIRED`, `INVALID_API_KEY`, `FORBIDDEN`, `SESSION_NOT_FOUND`, `SESSION_ENDED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `INTERNAL_ERROR`.

## Deliverables

1. `packages/gateway/` with Hono server
2. REST API (all session, agent, usage, API key endpoints)
3. WebSocket server with ProxyAssistantMessageEvent streaming
4. SSE endpoint for event streaming
5. A2A protocol implementation (Agent Card, all JSON-RPC methods)
6. gRPC client for orchestrator communication
7. Auth middleware (Better Auth session + API key)
8. Rate limiting middleware (configurable via settings)
9. Error handling
10. Integration tests against real PostgreSQL + Valkey
