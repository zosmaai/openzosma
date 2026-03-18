# Phase 2: OpenZosma Monorepo Setup

**Duration:** 1 week
**Priority:** P0
**Depends on:** Phase 1 (multi-instance refactor must be complete)

## Goal

Create the OpenZosma monorepo with infrastructure, database schema, auth, gRPC definitions, and the foundational package structure.

## Monorepo Setup

### Tooling

- **pnpm workspaces** for package management
- **Turborepo** for build orchestration
- **TypeScript** with project references
- **Vitest** for testing
- **Biome** for linting/formatting

### Root Configuration

```
openzosma/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── biome.json
├── docker-compose.yml
├── .env.example
├── proto/
│   ├── orchestrator.proto
│   └── sandbox.proto
├── packages/
│   ├── db/
│   ├── auth/
│   ├── grpc/
│   ├── gateway/
│   ├── orchestrator/
│   ├── sandbox/
│   ├── a2a/
│   ├── adapters/
│   │   ├── slack/
│   │   └── whatsapp/
│   ├── skills/
│   │   └── reports/
│   └── sdk/
├── apps/
│   └── web/
├── infra/
│   ├── openshell/
│   └── k8s/
└── docs/
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "packages/adapters/*"
  - "packages/skills/*"
  - "apps/*"
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "check": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

## Docker Compose (Development)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: openzosma
      POSTGRES_USER: openzosma
      POSTGRES_PASSWORD: openzosma
    volumes:
      - pgdata:/var/lib/postgresql/data

  valkey:
    image: valkey/valkey:8-alpine
    ports: ["6379:6379"]

  rabbitmq:
    image: rabbitmq:4-management-alpine
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: openzosma
      RABBITMQ_DEFAULT_PASS: openzosma

volumes:
  pgdata:
```

## Database (`packages/db/`)

Raw SQL via `pg` driver. Migrations via `node-pg-migrate`. No ORM.

### Package Structure

```
packages/db/
├── package.json
├── src/
│   ├── index.ts          # exports pool, query helpers
│   ├── pool.ts           # pg Pool creation from env vars
│   ├── queries/
│   │   ├── users.ts      # user CRUD queries
│   │   ├── sessions.ts   # session CRUD queries
│   │   ├── messages.ts   # message CRUD queries
│   │   ├── agent-configs.ts
│   │   ├── api-keys.ts
│   │   ├── usage.ts
│   │   ├── connections.ts
│   │   └── settings.ts
│   └── types.ts          # TypeScript interfaces for rows
├── migrations/
│   ├── 001_create-users.sql
│   ├── 002_create-sessions.sql
│   ├── 003_create-messages.sql
│   ├── 004_create-agent-configs.sql
│   ├── 005_create-api-keys.sql
│   ├── 006_create-usage.sql
│   ├── 007_create-connections.sql
│   └── 008_create-settings.sql
└── migrate.ts            # node-pg-migrate runner
```

### Migration: `001_create-users.sql`

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  auth_provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Migration: `002_create-sessions.sql`

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  agent_config_id UUID,
  sandbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'active', 'paused', 'ended', 'failed')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

### Migration: `003_create-messages.sql`

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT,
  tool_calls JSONB,
  tool_results JSONB,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_session ON messages(session_id);
```

### Migration: `004_create-agent-configs.sql`

```sql
CREATE TABLE agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  system_prompt TEXT,
  tools_enabled JSONB DEFAULT '[]',
  skills JSONB DEFAULT '[]',
  max_tokens INTEGER DEFAULT 4096,
  temperature REAL DEFAULT 0.7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Migration: `005_create-api-keys.sql`

```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes JSONB DEFAULT '["sessions:read", "sessions:write"]',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Migration: `006_create-usage.sql`

```sql
CREATE TABLE usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL DEFAULT 0,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_created ON usage(created_at);
CREATE INDEX idx_usage_session ON usage(session_id);
```

### Migration: `007_create-connections.sql`

```sql
CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('postgresql', 'mysql', 'mongodb', 'clickhouse', 'bigquery', 'sqlite', 'generic_sql')),
  encrypted_credentials TEXT NOT NULL,
  schema_cache JSONB,
  read_only BOOLEAN NOT NULL DEFAULT true,
  query_timeout INTEGER DEFAULT 30,
  row_limit INTEGER DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Migration: `008_create-settings.sql`

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default settings
INSERT INTO settings (key, value) VALUES
  ('instance_name', '"OpenZosma"'),
  ('sandbox_pool_size', '2'),
  ('max_concurrent_sessions', '10'),
  ('max_session_duration_seconds', '3600'),
  ('max_turns_per_session', '100');
```

### Query Helpers

```typescript
// packages/db/src/pool.ts
import pg from "pg"

export function createPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: parseInt(process.env.DB_PORT ?? "5432"),
    database: process.env.DB_NAME ?? "openzosma",
    user: process.env.DB_USER ?? "openzosma",
    password: process.env.DB_PASS ?? "openzosma",
    max: parseInt(process.env.DB_POOL_SIZE ?? "20"),
  })
}
```

```typescript
// packages/db/src/queries/sessions.ts
import type { Pool } from "pg"

export interface Session {
  id: string
  userId: string
  agentConfigId: string | null
  sandboxId: string | null
  status: "created" | "active" | "paused" | "ended" | "failed"
  metadata: Record<string, unknown>
  createdAt: Date
  endedAt: Date | null
}

export async function createSession(
  pool: Pool,
  userId: string,
  agentConfigId?: string,
  metadata?: Record<string, unknown>,
): Promise<Session> {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, agent_config_id, metadata)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, agentConfigId ?? null, JSON.stringify(metadata ?? {})],
  )
  return mapSession(result.rows[0])
}

export async function getSession(pool: Pool, id: string): Promise<Session | null> {
  const result = await pool.query("SELECT * FROM sessions WHERE id = $1", [id])
  return result.rows[0] ? mapSession(result.rows[0]) : null
}

export async function updateSessionStatus(
  pool: Pool,
  id: string,
  status: Session["status"],
): Promise<void> {
  const endedAt = status === "ended" || status === "failed" ? "now()" : "NULL"
  await pool.query(
    `UPDATE sessions SET status = $1, ended_at = ${endedAt === "NULL" ? "NULL" : "now()"} WHERE id = $2`,
    [status, id],
  )
}

export async function getActiveSessions(pool: Pool): Promise<Session[]> {
  const result = await pool.query(
    "SELECT * FROM sessions WHERE status IN ('created', 'active') ORDER BY created_at DESC",
  )
  return result.rows.map(mapSession)
}

function mapSession(row: any): Session {
  return {
    id: row.id,
    userId: row.user_id,
    agentConfigId: row.agent_config_id,
    sandboxId: row.sandbox_id,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    endedAt: row.ended_at,
  }
}
```

### Migration Runner

```typescript
// packages/db/src/migrate.ts
import { default as migrate } from "node-pg-migrate"
import { createPool } from "./pool.js"

export async function runMigrations(direction: "up" | "down" = "up") {
  const pool = createPool()
  try {
    await migrate({
      databaseUrl: {
        host: process.env.DB_HOST ?? "localhost",
        port: parseInt(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "openzosma",
        user: process.env.DB_USER ?? "openzosma",
        password: process.env.DB_PASS ?? "openzosma",
      },
      dir: "migrations",
      direction,
      migrationsTable: "pgmigrations",
    })
  } finally {
    await pool.end()
  }
}
```

## gRPC Definitions (`packages/grpc/`, `proto/`)

Proto definitions for internal service communication.

### `proto/orchestrator.proto`

```protobuf
syntax = "proto3";

package openzosma.orchestrator;

service OrchestratorService {
  rpc CreateSession(CreateSessionRequest) returns (Session);
  rpc EndSession(EndSessionRequest) returns (Empty);
  rpc SendMessage(SendMessageRequest) returns (stream AgentEvent);
  rpc CancelTurn(CancelTurnRequest) returns (Empty);
  rpc GetSession(GetSessionRequest) returns (Session);
  rpc ListActiveSessions(ListActiveSessionsRequest) returns (SessionList);
}

message CreateSessionRequest {
  string user_id = 1;
  optional string agent_config_id = 2;
  map<string, string> metadata = 3;
}

message EndSessionRequest {
  string session_id = 1;
}

message SendMessageRequest {
  string session_id = 1;
  string content = 2;
  repeated Attachment attachments = 3;
}

message CancelTurnRequest {
  string session_id = 1;
}

message GetSessionRequest {
  string session_id = 1;
}

message ListActiveSessionsRequest {}

message Session {
  string id = 1;
  string user_id = 2;
  string status = 3;
  string sandbox_id = 4;
  int64 created_at = 5;
}

message SessionList {
  repeated Session sessions = 1;
}

message AgentEvent {
  string type = 1;           // agent_start, turn_start, message_start, message_update, etc.
  optional string id = 2;
  optional string text = 3;
  optional string name = 4;  // tool name
  optional string input = 5; // tool input
  optional string output = 6;// tool output
}

message Attachment {
  string filename = 1;
  string content_type = 2;
  bytes data = 3;
}

message Empty {}
```

### `proto/sandbox.proto`

```protobuf
syntax = "proto3";

package openzosma.sandbox;

service SandboxAgentService {
  // Bidirectional: orchestrator sends user messages, sandbox streams agent events
  rpc ProcessMessage(stream AgentMessage) returns (stream AgentEvent);
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
}

message AgentMessage {
  string type = 1;    // "message", "cancel", "config"
  optional string content = 2;
  optional string config_json = 3;  // initial session config (tools, model, system prompt)
}

message AgentEvent {
  string type = 1;
  optional string id = 2;
  optional string text = 3;
  optional string name = 4;
  optional string input = 5;
  optional string output = 6;
}

message HealthCheckRequest {}

message HealthCheckResponse {
  bool healthy = 1;
  string status = 2;
}
```

### `packages/grpc/` Structure

```
packages/grpc/
├── package.json
├── src/
│   ├── index.ts          # re-exports generated types + client/server helpers
│   ├── generated/        # protobuf-ts output (gitignored, built from proto/)
│   │   ├── orchestrator.ts
│   │   └── sandbox.ts
│   └── helpers.ts        # createChannel, createServer utilities
├── scripts/
│   └── generate.ts       # runs protobuf-ts codegen
└── tsconfig.json
```

Code generation uses `protobuf-ts`:

```json
// package.json scripts
{
  "scripts": {
    "generate": "npx protoc --ts_out src/generated --proto_path ../../proto ../../proto/*.proto",
    "build": "npm run generate && tsc"
  }
}
```

## Auth (`packages/auth/`)

### Better Auth Configuration

```typescript
import { betterAuth } from "better-auth"
import { Pool } from "pg"

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? "5432"),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
})

export const auth = betterAuth({
  database: {
    type: "postgres",
    pool,
  },
  emailAndPassword: { enabled: true },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,  // 7 days
    updateAge: 60 * 60 * 24,      // 1 day
  },
})
```

### API Key Auth (Custom Middleware)

```typescript
// Hono middleware for API key authentication
async function apiKeyAuth(c: Context, next: Next) {
  const key = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!key) return c.json({ error: "Missing API key" }, 401)

  const keyHash = await hashApiKey(key)
  const result = await pool.query(
    "SELECT * FROM api_keys WHERE key_hash = $1",
    [keyHash],
  )
  const apiKey = result.rows[0]

  if (!apiKey || (apiKey.expires_at && new Date(apiKey.expires_at) < new Date())) {
    return c.json({ error: "Invalid API key" }, 401)
  }

  // Update last_used_at
  await pool.query(
    "UPDATE api_keys SET last_used_at = now() WHERE id = $1",
    [apiKey.id],
  )

  c.set("userId", null)  // API key access, no user context
  c.set("scopes", apiKey.scopes)
  await next()
}
```

### RBAC

Roles:
- **admin** -- manage users, agent configs, connections, settings, API keys
- **member** -- create sessions, view own history

No owner role needed. The first user registered is auto-promoted to admin.

## Deliverables

1. Monorepo with pnpm workspaces and Turborepo
2. `docker-compose.yml` for local development
3. `packages/db/` with raw SQL migrations (node-pg-migrate) and query helpers
4. `packages/grpc/` with proto definitions and generated TypeScript stubs
5. `packages/auth/` with Better Auth + API key middleware
6. All packages scaffolded with `package.json`, `tsconfig.json`, `src/index.ts`
7. `pnpm run build` and `pnpm run check` pass
