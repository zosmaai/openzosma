# OpenZosma

Open-source, self-hosted AI agent platform. Exposes agents via [A2A protocol](https://github.com/google/A2A), REST API, WebSocket, and gRPC. Sandboxes each session using [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) (running agents inside [OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes with Landlock + seccomp + network namespace isolation). Supports multiple communication channels: Web, Mobile, WhatsApp, Slack, and agent-to-agent.

Built on top of [pi-mono](https://github.com/badlogic/pi-mono) (TypeScript agent SDK).

## Getting Started

### Prerequisites

- [Node.js 22+](https://nodejs.org/) (see `.nvmrc`)
- [pnpm 9+](https://pnpm.io/)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [NemoClaw CLI](https://github.com/NVIDIA/NemoClaw) (for sandbox development)

### Quick Start

```bash
# Clone the repo
git clone https://github.com/zosmaai/openzosma.git
cd openzosma

# Install dependencies
pnpm install

# Start infrastructure (PostgreSQL, Valkey, RabbitMQ)
docker compose up -d

# Copy environment config
cp .env.example .env
# Edit .env with your settings (LLM API keys, auth secret, etc.)

# Run database migrations
pnpm db:migrate

# Generate gRPC stubs from proto definitions
pnpm proto:generate

# Build all packages
pnpm run build

# Type check
pnpm run check
```

### Docker (Development)

For contributors who prefer not to install Node.js and pnpm locally:

```bash
docker build -f Dockerfile.dev -t openzosma-dev .
docker run -it --rm -v $(pwd):/app -p 4000:4000 -p 50051:50051 openzosma-dev bash
```

### Docker (Production)

Build individual services using multi-stage targets:

```bash
# API Gateway
docker build --target gateway -t openzosma-gateway .

# Orchestrator
docker build --target orchestrator -t openzosma-orchestrator .
```

## Architecture Overview

```
Clients (Web, Mobile, Slack, WhatsApp, A2A agents)
                    |
            API Gateway (Hono)
       REST / WebSocket / A2A / gRPC
                    |
          Orchestrator (gRPC)
        (session mgmt, routing,
         configurable quotas)
                    |
        +-----------+-----------+
        |           |           |
   NemoClaw     NemoClaw     NemoClaw
   Sandbox A    Sandbox B    Sandbox C
  (OpenShell     (OpenShell    (OpenShell
   isolation,    isolation,    isolation,
   pi-agent      pi-agent     pi-agent
   via gRPC)     via gRPC)    via gRPC)
```

Each agent session runs inside an isolated NemoClaw sandbox (Landlock + seccomp + network namespace isolation, deny-by-default network policies). The orchestrator manages sandbox lifecycle and routes messages. Internal communication between gateway, orchestrator, and sandboxes uses gRPC with bidirectional streaming. External clients use REST, WebSocket, or A2A.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

## Repository Structure

```
openzosma/
├── packages/
│   ├── db/                   # node-pg-migrate migrations, raw SQL queries (PostgreSQL)
│   ├── auth/                 # Better Auth setup
│   ├── gateway/              # Hono HTTP server (REST + WS + A2A)
│   ├── orchestrator/         # Session lifecycle, sandbox pool
│   ├── sandbox/              # NemoClaw sandbox wrapper
│   ├── a2a/                  # A2A protocol implementation
│   ├── grpc/                 # Proto definitions + generated stubs
│   ├── adapters/
│   │   ├── web/              # WebSocket adapter
│   │   ├── whatsapp/         # WhatsApp Business API
│   │   └── slack/            # Slack adapter
│   ├── skills/
│   │   └── reports/          # PDF, PPTX, charts
│   └── sdk/                  # Client SDK (@openzosma/sdk)
├── apps/
│   ├── web/                  # Next.js dashboard (client-only)
│   └── mobile/               # React Native app (deferred)
├── proto/                    # .proto service definitions
├── infra/
│   ├── openshell/            # NemoClaw sandbox Dockerfile + policies
│   └── k8s/                  # Kubernetes manifests (production)
├── docs/                     # Phase-by-phase implementation plans
├── ARCHITECTURE.md           # System architecture
├── AGENTS.md                 # Instructions for AI coding agents
├── CONTRIBUTING.md           # Development setup and conventions
└── LICENSE                   # Apache 2.0
```

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 (TypeScript) |
| Agent SDK | pi-mono (`pi-agent-core`, `pi-ai`, `pi-coding-agent`) |
| HTTP Server | Hono |
| Internal RPC | gRPC (`@grpc/grpc-js`, `protobuf-ts`) |
| A2A Protocol | `@a2a-js/sdk` + Hono |
| Database | PostgreSQL (raw SQL via `pg`, migrations via `node-pg-migrate`) |
| Cache / Pub-Sub | Valkey (Redis-compatible) |
| Job Queue | RabbitMQ |
| Auth | Better Auth |
| Sandbox | NVIDIA NemoClaw + OpenShell (Landlock, seccomp, network namespace isolation) |
| Web Dashboard | Next.js |
| Mobile | React Native (deferred) |

## Implementation Phases

| Phase | Description | Duration | Status |
|-------|-------------|----------|--------|
| [Phase 1](./docs/PHASE-1-MULTITENANT.md) | Multi-instance pi-agent refactor (in pi-mono) | 3-4 days | Complete |
| [Phase 2](./docs/PHASE-2-MONOREPO.md) | OpenZosma monorepo setup + DB schema + auth | 1 week | Complete |
| [Phase 3](./docs/PHASE-3-GATEWAY.md) | API Gateway + A2A + gRPC server | 1 week | Not started |
| [Phase 4](./docs/PHASE-4-ORCHESTRATOR.md) | Orchestrator + NemoClaw sandbox integration | 1.5 weeks | Not started |
| [Phase 5](./docs/PHASE-5-ADAPTERS.md) | Channel adapters (Slack, WhatsApp) | 1 week | Not started |
| [Phase 6](./docs/PHASE-6-SKILLS.md) | Enterprise skills (database tool, reports) | 2 weeks | Not started |
| [Phase 7](./docs/PHASE-7-DASHBOARD.md) | Web dashboard (Next.js) | 2 weeks | Not started |

**MVP (Phases 1-4):** ~4 weeks
**Full platform (Phases 1-7):** ~10 weeks

## Self-Hosted

One instance = one organization. Deploy with Docker Compose for development or Kubernetes for production.

## Related Repositories

- **[pi-mono](https://github.com/badlogic/pi-mono)** -- Agent SDK. Published as npm packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, etc.). OpenZosma depends on these packages.
- **[NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw)** -- Sandbox runtime. Runs agents inside OpenShell sandboxes with Landlock + seccomp + network namespace isolation, deny-by-default network policies, and inference routing.
- **[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)** -- Underlying sandbox infrastructure. K3s-based isolation with declarative YAML policies.
- **[Google A2A](https://github.com/google/A2A)** -- Agent-to-Agent protocol. JSON-RPC 2.0 over HTTPS with SSE streaming and gRPC support.

## License

[Apache License 2.0](./LICENSE)
