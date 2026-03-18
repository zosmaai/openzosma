# Agent Instructions

Instructions for AI coding agents working on the OpenZosma codebase.

## Project Context

OpenZosma is a self-hosted AI agent platform. It is a separate repository from `pi-mono` (the agent SDK it depends on). Read [README.md](./README.md) for an overview and [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

Do NOT add tenant_id columns, tenant resolution middleware, or per-tenant logic to this codebase.

## First Message

If the user did not give you a concrete task, read README.md and ARCHITECTURE.md first. Then ask which component to work on. Based on the answer, read the relevant phase doc:
- [docs/PHASE-1-MULTITENANT.md](./docs/PHASE-1-MULTITENANT.md) -- pi-mono refactor
- [docs/PHASE-2-MONOREPO.md](./docs/PHASE-2-MONOREPO.md) -- repo setup, DB, auth
- [docs/PHASE-3-GATEWAY.md](./docs/PHASE-3-GATEWAY.md) -- API gateway + gRPC
- [docs/PHASE-4-ORCHESTRATOR.md](./docs/PHASE-4-ORCHESTRATOR.md) -- orchestrator, sandboxes
- [docs/PHASE-5-ADAPTERS.md](./docs/PHASE-5-ADAPTERS.md) -- channel adapters
- [docs/PHASE-6-SKILLS.md](./docs/PHASE-6-SKILLS.md) -- database tool, reports
- [docs/PHASE-7-DASHBOARD.md](./docs/PHASE-7-DASHBOARD.md) -- web dashboard

## Code Quality

- TypeScript throughout. No `any` types unless absolutely necessary.
- No inline imports (`await import("./foo.js")`, `import("pkg").Type`). Always use standard top-level imports.
- Check `node_modules` for external API type definitions instead of guessing.
- Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.
- Always ask before removing functionality or code that appears intentional.

## Architecture Rules

- **Self-hosted.** No `tenant_id` columns. No tenant resolution. One instance = one organization.
- **Backend and frontend are strictly separate.** The backend (`packages/`) is a standalone TypeScript service. The web dashboard (`apps/web/`) is an independent consumer. No Next.js API routes in the critical path.
- **No ORM.** Raw SQL via `pg` driver. Migrations via `node-pg-migrate`. No Drizzle, no Prisma, no TypeORM.
- **No global state.** All state must be scoped to a session or explicitly shared via Valkey/PostgreSQL. Module-level singletons are forbidden.
- **Per-session isolation.** Every agent session gets its own sandbox, tool instances, caches, and config. No cross-session data leakage.
- **gRPC for internal communication.** Gateway <-> Orchestrator and Orchestrator <-> Sandbox use gRPC. External clients use REST/WebSocket/A2A.
- **Pi-mono is a dependency, not a fork.** Changes to agent behavior go in pi-mono. OpenZosma only wraps, configures, and orchestrates.

## Repository Structure

```
openzosma/
├── packages/           # Backend packages (TypeScript)
│   ├── db/             # node-pg-migrate migrations, raw SQL queries
│   ├── auth/           # Better Auth
│   ├── gateway/        # Hono HTTP server
│   ├── orchestrator/   # Session lifecycle, sandbox pool
│   ├── sandbox/        # OpenShell wrapper
│   ├── a2a/            # A2A protocol
│   ├── grpc/           # Proto definitions + generated stubs
│   ├── adapters/       # Channel adapters (slack, whatsapp)
│   ├── skills/         # Reports
│   └── sdk/            # Client SDK
├── proto/              # .proto service definitions
├── apps/
│   ├── web/            # Next.js dashboard
│   └── mobile/         # React Native (deferred)
├── infra/              # OpenShell policies, K8s manifests
└── docs/               # Phase implementation plans
```

## Commands

- Build: `pnpm run build` (from repo root, uses Turborepo)
- Type check: `pnpm run check` (get full output, fix all errors/warnings before committing)
- Migrations: `pnpm --filter @openzosma/db run migrate up`
- Generate gRPC stubs: `pnpm --filter @openzosma/grpc run generate`
- Test specific package: run from package root, e.g., `cd packages/gateway && npx vitest --run`
- Never run: `pnpm run dev` (unless the user explicitly asks)
- Never commit unless the user asks

## Dependencies

- **pi-mono packages:** `pi-ai`, `pi-agent-core`, `pi-coding-agent` (npm)
- **Hono:** HTTP server framework
- **pg:** PostgreSQL client (raw SQL, no ORM)
- **node-pg-migrate:** Database migrations
- **@grpc/grpc-js + protobuf-ts:** gRPC server/client + proto codegen
- **Better Auth:** Authentication
- **@a2a-js/sdk:** A2A protocol
- **Valkey/ioredis:** Cache, pub/sub
- **amqplib:** RabbitMQ client

## Database Conventions

- Migrations are SQL files in `packages/db/migrations/`
- Table and column names use `snake_case`
- All tables have `id` (UUID, primary key) and `created_at` (timestamptz)
- No `tenant_id` columns
- Queries use parameterized placeholders (`$1`, `$2`, etc.), never string interpolation
- Connection pooling via `pg.Pool`

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only

## Git Rules

- Never use `git add -A` or `git add .` -- always stage specific files
- Never use `git commit --no-verify`
- Never force push to main
- Include `fixes #<number>` or `closes #<number>` in commit messages when applicable
- Commit message format: `type(scope): description` (e.g., `feat(gateway): add session creation endpoint`)

## Pi-Mono Reference

The agent SDK lives at `../pi-mono/` (sibling directory). Key source locations:

| What | Location |
|---|---|
| Agent class, event system | `packages/agent/src/agent.ts` |
| AgentEvent types | `packages/agent/src/types.ts:199-214` |
| StreamFn type | `packages/agent/src/types.ts:23` |
| ProxyAssistantMessageEvent | `packages/agent/src/proxy.ts:36-57` |
| EventStream | `packages/ai/src/utils/event-stream.ts` |
| AgentSession | `packages/coding-agent/src/core/session.ts` |
| SessionManager | `packages/coding-agent/src/core/session-manager.ts` |
| Tool factories | `packages/coding-agent/src/core/tools/*.ts` |
| RPC mode | `packages/coding-agent/src/main.ts` (stdin/stdout JSONL) |
| Slack bot reference | `packages/mom/src/` |

When working on Phase 1 (multi-instance refactor), you will be editing files in `../pi-mono/packages/coding-agent/`.
