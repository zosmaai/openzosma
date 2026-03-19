# Plan: Digital Work Twins

This document describes the implementation plan for OpenZosma's digital twin agent system. Each phase is independently shippable.

## Vision

OpenZosma is a platform for creating AI agents that act as digital work twins -- agents that represent real people, know what they know, and can collaborate with other twins on behalf of their human. In the OSS version, users create twin agents manually via a conversational setup wizard. In the Cloud version, twins are auto-created when team members are onboarded.

Twins are Pi-based agents (using `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` from [pi-mono](https://github.com/badlogic/pi-mono)). They run unsandboxed initially (NemoClaw sandboxing deferred). They communicate with each other via A2A protocol. Each twin knows it is a digital twin acting on behalf of its human.

Reference implementation: `@mariozechner/pi-mom` (Slack bot that embeds a Pi agent in a server context with per-channel state, persistent sessions, tool execution, and streaming responses).

## Current State

The MVP implements a minimal end-to-end flow: user sends a message in the dashboard, gets a streaming response from OpenAI's `gpt-4o-mini` via the `openai` npm package. Sessions are in-memory. No auth, no persistence, no tools, no agent loop.

```
Dashboard (Next.js :3000) --WebSocket--> Gateway (Hono :4000) --API--> OpenAI
```

## Monorepo Restructuring (Pre-Phase)

Before feature work, clean up the repo structure.

### Move proto into grpc

Move `proto/*.proto` into `packages/grpc/proto/`. Update `packages/grpc/scripts/generate.ts` to reference `../proto/` instead of `../../../proto/`. Delete root `proto/` directory.

### Remove openai dependency

Remove `openai` from `packages/gateway/package.json`. Replace with `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

---

## Phase 0: Replace OpenAI with Real Pi Agent

**Goal:** Replace the dumb OpenAI wrapper with a real Pi agent that can reason, call tools, and do actual work.

**Priority:** Highest. Everything else builds on this.

### Gateway Changes

**`packages/gateway/package.json`** -- dependency swap:
```diff
- "openai": "^4.85.4"
+ "@mariozechner/pi-agent-core": "^0.57.0"
+ "@mariozechner/pi-ai": "^0.57.0"
+ "@mariozechner/pi-coding-agent": "^0.57.0"
```

`pi-coding-agent` is needed for `convertToLlm`, `AgentSession` (auto-compaction, auto-retry, persistence), and `SessionManager` (context.jsonl management).

**`packages/gateway/src/session-manager.ts`** -- full rewrite:

Pattern follows `pi-mom/src/agent.ts`:

```
Per session:
  1. Create Agent instance with system prompt, model, tools, getApiKey
  2. Create SessionManager for persistent context (context.jsonl equivalent, or DB-backed)
  3. Create AgentSession wrapper for auto-compaction and retry
  4. Subscribe to AgentEvents once (event handler references mutable per-run state)

Per message:
  1. Sync any missed messages into session context
  2. Rebuild system prompt if needed
  3. Call session.prompt(userMessage)
  4. Stream AgentEvents back via the existing AsyncGenerator pattern
```

Key differences from pi-mom:
- No Slack -- events stream over WebSocket to the dashboard
- Sessions stored in DB (not channel directories)
- No Docker executor -- tools execute on the host directly (unsandboxed)

**Agent configuration:**

Default agent (used when no specific agent is selected):
- Model: read from `OPENZOSMA_MODEL` env var, default `anthropic/claude-sonnet-4-20250514`
- System prompt: generic helpful assistant
- Tools: all available (read, write, edit, bash, grep, glob, ls)
- API key: from env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) via `getEnvApiKey()`

**Tool integration:**

Reuse tool factories from `pi-coding-agent` where possible. The coding agent's tools use an `Executor` interface (same pattern as pi-mom's `HostExecutor`). Create a `HostExecutor` that runs commands directly via `child_process`.

Tools to enable:
| Tool | Source | Description |
|------|--------|-------------|
| bash | pi-mom pattern | Execute shell commands via HostExecutor |
| read | pi-mom pattern | Read files with offset/limit, images as base64 |
| write | pi-mom pattern | Write files, auto-create parent dirs |
| edit | pi-mom pattern | Find-and-replace with exact matching, unified diff output |
| grep | pi-coding-agent | Search file contents with regex |
| glob | pi-coding-agent | Find files by glob pattern |
| ls | pi-coding-agent | List directory contents |

### Event Type Expansion

**`packages/gateway/src/types.ts`** -- add new event types:

```typescript
export type AgentEventType =
  // Existing
  | "turn_start" | "message_start" | "message_update" | "message_end" | "turn_end" | "error"
  // New: tool calls
  | "tool_call_start" | "tool_call_update" | "tool_call_end"
  // New: thinking
  | "thinking_start" | "thinking_update" | "thinking_end"

export interface AgentEvent {
  type: AgentEventType
  id?: string
  text?: string
  error?: string
  // Tool call fields
  toolName?: string
  toolArgs?: unknown
  toolResult?: unknown
  isToolError?: boolean
}
```

Map Pi `AgentEvent` types to gateway events:
| Pi Event | Gateway Event |
|----------|---------------|
| `agent_start` | `turn_start` |
| `message_start` | `message_start` |
| `message_update` (text_delta) | `message_update` |
| `message_update` (thinking_delta) | `thinking_update` |
| `message_end` | `message_end` |
| `tool_execution_start` | `tool_call_start` |
| `tool_execution_update` | `tool_call_update` |
| `tool_execution_end` | `tool_call_end` |
| `agent_end` | `turn_end` |

### Dashboard Changes

**`apps/web/src/app/chat/page.tsx`:**
- Add markdown rendering (add `react-markdown` + `remark-gfm` as dependencies)
- Add tool call visualization: collapsible panels showing tool name, arguments, result, duration
- Add thinking block display: collapsible "Reasoning..." section with italic text
- Handle new event types from WebSocket

### Deliverable

Chat with a real Pi agent. Agent can read files, execute commands, write code, search the codebase. Full tool execution visible in the UI with streaming.

---

## Phase 1: Token Auth + DB Persistence

**Goal:** Protect the instance with a token and persist sessions to PostgreSQL.

### Token Auth

Single-user token model (no signup, no user accounts for OSS):

1. On first startup, if `settings` table has no `instance_token` key:
   - Generate token: `ozt_<32 random hex bytes>`
   - Hash with SHA-256, store hash in settings table
   - Print raw token to console: `Access token: ozt_abc123...`
   - Also writable via env var `OPENZOSMA_TOKEN` (takes precedence)

2. Gateway middleware (Hono):
   - Check `Authorization: Bearer <token>` header
   - Or `?token=<token>` query parameter
   - Validate by hashing and comparing to stored hash
   - Skip auth for `/health` endpoint
   - Return 401 for invalid/missing token

3. Dashboard:
   - On load, check localStorage for token
   - If missing, show single input field: "Enter your access token"
   - Store in localStorage, include in WebSocket connection and REST requests
   - Add "Lock" icon in header showing auth status

### DB Persistence

Replace in-memory session storage with PostgreSQL using existing `@openzosma/db` queries.

**Session lifecycle:**
- `createSession()` -> `sessionQueries.createSession(pool, ...)`
- Session metadata includes agent config reference
- Status transitions: `created -> active -> ended` (or `failed`)

**Message persistence:**
- Before prompting agent: save user message via `messageQueries.createMessage()`
- After agent response: save assistant message with token counts
- Tool calls stored in `tool_calls` JSONB column

**Agent instance management:**
- `Map<string, Agent>` as LRU cache (max 50 sessions)
- On session access: if not in cache, create new Agent, load messages from DB via `messageQueries.getMessagesBySession()`, rebuild agent state via `agent.replaceMessages()`
- Pi Agent's `convertToLlm` handles message format conversion

**Usage tracking:**
- After each agent turn, record via `usageQueries.recordUsage()` with token counts from `usage` events

### Deliverable

Authenticated access. Sessions survive gateway restarts. Usage tracked in DB.

---

## Phase 2: Agent Creation Wizard + JSON Config

**Goal:** Users create custom agents via conversational interview. Configs stored as JSON.

### Agent Config Schema

Single JSONB column in `agent_configs` table. Migration:

```sql
-- 009_agent-config-json.sql
ALTER TABLE agent_configs ADD COLUMN config JSONB;
```

JSON schema:

```json
{
  "name": "Alice Chen",
  "role": "Senior Backend Engineer",
  "department": "Engineering",
  "persona": "Direct, technical, prefers code examples over prose. Uses dry humor. Responds concisely unless asked to elaborate.",
  "systemPrompt": "You are Alice Chen's digital work twin...",
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-20250514"
  },
  "tools": ["bash", "read", "write", "edit", "grep", "glob", "ls"],
  "knowledge": {
    "paths": ["/data/engineering/backend/"],
    "description": "Backend architecture docs, API specs, deployment runbooks"
  },
  "memory": {
    "enabled": true
  },
  "style": {
    "tone": "technical",
    "verbosity": "concise"
  }
}
```

### Conversational Setup Wizard

New route: `/agents/new`

The wizard is itself a Pi agent with:
- System prompt: interviews the user about the person this agent represents
- Tool: `save_agent_config(config)` -- validates JSON schema, writes to DB, returns the created agent ID
- Tool: `preview_system_prompt(config)` -- generates a system prompt from the config and shows it to the user for approval

Flow:
1. User navigates to `/agents/new`
2. Setup agent asks: "Who would you like to create a digital twin for? Tell me about them -- their name, role, how they communicate..."
3. User describes the person over 2-5 messages
4. Setup agent generates the config JSON, shows a preview of the system prompt
5. User approves or requests changes
6. Setup agent calls `save_agent_config()` to persist

### Agent Management UI

- Sidebar: list of created agents (name + role subtitle)
- Click agent -> open chat session with that agent
- Gear icon -> view/edit raw JSON config (textarea with syntax highlighting, or basic JSON editor)
- Default agent always present (generic assistant, not a twin)

### Agent Config -> Pi Agent

When a session starts with an agent config:

```
1. Load config from agent_configs table
2. Parse model: getModel(config.model.provider, config.model.id)
3. Build system prompt from config (persona + role + knowledge description)
4. Map tool names to AgentTool instances
5. Set knowledge paths -> scope file tools to those directories
6. Create Agent with these options
```

### Deliverable

Users create agent personas via conversation. Multiple agents in sidebar. Each agent has its own personality, tools, and knowledge scope.

---

## Phase 3: Knowledge + Memory

**Goal:** Agents can access scoped files and remember things across sessions.

### Per-Agent Knowledge

Each agent config specifies `knowledge.paths` -- directories the agent can read/search. Implementation:

- File tools (read, grep, glob, ls) are scoped to the agent's allowed paths
- Scope enforcement: tool `execute()` validates that requested paths are within allowed directories (prefix check)
- If no paths configured, tools have full filesystem access (default for OSS)
- `knowledge.description` is injected into the system prompt so the agent knows what knowledge is available

### Agent Memory

After conversations, agents can persist key learnings.

**Memory storage:**
- `memory` JSONB column on `agent_configs` table (or separate `agent_memory` table)
- Array of `{ timestamp: string, fact: string, source: string }` entries
- Max 200 entries (oldest evicted when full)

**Memory tool:**
```
save_memory(fact: string, source?: string)
  -- Persists a fact the agent learned during conversation
  -- source: "user said", "file content", "conversation inference"
```

**Memory injection via transformContext:**
- Before each LLM call, `transformContext` prepends memory entries to the context
- Format: `<agent_memory>\n- [2026-03-19] User prefers PostgreSQL over MySQL\n- ...\n</agent_memory>`
- Most recent 50 entries injected (rest available via a `recall_memory(query)` tool)

### Deliverable

Agents remember facts across sessions. Knowledge scoped to configured paths.

---

## Phase 4: A2A Multi-Agent Communication (Local)

**Goal:** Agents on the same instance can discover and communicate with each other.

### Agent Registry

Each agent registers an A2A Agent Card on creation:

```json
{
  "name": "Alice Chen (Twin)",
  "description": "Digital work twin of Alice Chen, Senior Backend Engineer",
  "url": "http://localhost:4000/a2a/agents/alice-chen",
  "capabilities": {
    "tools": ["bash", "read", "write", "edit", "grep", "glob"],
    "knowledge": ["backend architecture", "API design", "deployment"]
  },
  "metadata": {
    "role": "Senior Backend Engineer",
    "department": "Engineering"
  }
}
```

Stored in `a2a_agent_card` JSONB column on `agent_configs` table.

### Discovery

`discover_agents(query?: string, department?: string)` tool:
- Queries the agent registry (DB)
- Filters by department, role, or free-text capability match
- Returns list of agent names and descriptions

### Inter-Agent Communication

`ask_agent(agentName: string, question: string)` tool:
- Looks up target agent config from DB
- Creates a temporary Pi Agent with the target's config
- Prompts it with the question
- Returns the response to the calling agent
- In OSS (single user), this is synchronous -- no human escalation needed

### Deliverable

Agents can discover each other and delegate questions. User asks their twin "what's the backend deployment process?" -> twin discovers Alice's twin has deployment knowledge -> asks Alice's twin -> gets the answer.

---

## Implementation Dependencies

```
Phase 0 (Pi Agent)
  --> Phase 1 (Auth + DB)
        --> Phase 2 (Agent Creation)
              --> Phase 3 (Knowledge + Memory)
              --> Phase 4 (A2A Multi-Agent)
```

Phases 3 and 4 are independent of each other (can be done in parallel).

## Estimated Effort

| Phase | Effort | Key Files |
|-------|--------|-----------|
| Pre-phase (restructure) | 1 day | packages/grpc/, proto/ |
| Phase 0 (Pi Agent) | 3-4 days | session-manager.ts, types.ts, chat/page.tsx |
| Phase 1 (Auth + DB) | 2-3 days | gateway middleware, session-manager.ts |
| Phase 2 (Agent creation) | 4-5 days | new routes, agent config UI, wizard agent |
| Phase 3 (Knowledge + Memory) | 3-4 days | transformContext, memory tool, tool scoping |
| Phase 4 (A2A local) | 3-4 days | agent registry, discovery tool, ask_agent tool |

Total: ~3-4 weeks to full local twin system.
