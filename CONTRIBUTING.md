# Contributing

## Development Setup

### Prerequisites

- [Node.js 22+](https://nodejs.org/) (see `.nvmrc` / `.node-version`)
- [pnpm 9+](https://pnpm.io/)
- Docker and Docker Compose (for PostgreSQL, Valkey, RabbitMQ)
- [NemoClaw CLI](https://github.com/NVIDIA/NemoClaw) (for sandbox development, Phase 4+)

### Getting Started

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
# Edit .env with your settings

# Run database migrations
pnpm db:migrate

# Generate gRPC stubs from proto definitions
pnpm proto:generate

# Build all packages
pnpm run build

# Type check
pnpm run check
```

### Using the Dev Container

If you prefer not to install Node.js and pnpm locally:

```bash
docker build -f Dockerfile.dev -t openzosma-dev .
docker run -it --rm \
  -v $(pwd):/app \
  -p 4000:4000 -p 50051:50051 \
  openzosma-dev bash
```

This gives you a shell with Node.js 22, pnpm, protoc, and build tools pre-installed.

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
# Database
DATABASE_URL=postgresql://openzosma:openzosma@localhost:5432/openzosma

# Valkey (Redis-compatible)
VALKEY_URL=redis://localhost:6379

# RabbitMQ
RABBITMQ_URL=amqp://openzosma:openzosma@localhost:5672

# Auth
BETTER_AUTH_SECRET=<random-secret>

# gRPC
ORCHESTRATOR_GRPC_PORT=50051
SANDBOX_GRPC_PORT=50052

# Sandbox pool
SANDBOX_POOL_SIZE=2

# LLM providers (at least one required for agent functionality)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

## Conventions

### Code Style

- TypeScript throughout
- No `any` types unless absolutely necessary
- No inline imports -- always standard top-level imports
- No global/module-level mutable state
- No ORM -- raw SQL via `pg`, migrations via `node-pg-migrate`

### Database

- Migrations are SQL files in `packages/db/migrations/`
- Create new migration: `pnpm --filter @openzosma/db run migrate create <name>`
- Run migrations: `pnpm --filter @openzosma/db run migrate up`
- Rollback: `pnpm --filter @openzosma/db run migrate down`
- Parameterized queries only (`$1`, `$2`, etc.), never string interpolation

### gRPC / Protobuf

- Proto definitions live in `proto/` at repo root
- Generated TypeScript stubs go to `packages/grpc/src/generated/`
- Regenerate after proto changes: `pnpm proto:generate`
- Code generation uses `@protobuf-ts/plugin` via `npx protoc`

### Git

- Branch naming: `feat/description`, `fix/description`, `refactor/description`
- Commit format: `type(scope): description`
  - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
  - Scopes: `gateway`, `orchestrator`, `sandbox`, `a2a`, `grpc`, `db`, `auth`, `adapters`, `skills`, `web`, `sdk`
- Include `fixes #N` or `closes #N` in commit messages for related issues
- Never force push to main

### Testing

- Use Vitest for unit and integration tests
- Test files live in `test/` directories alongside source, named `*.test.ts`
- Run from package root: `cd packages/gateway && npx vitest --run`
- Integration tests that need infrastructure should check for availability and skip gracefully
- See [docs/TESTING.md](./docs/TESTING.md) for the full testing strategy

### Pull Requests

- One feature or fix per PR
- Include tests for new functionality
- All checks must pass before merge
- PRs are reviewed, then merged to main

## Project Layout

```
packages/         Backend packages (each is an independent npm package)
proto/            Protobuf service definitions (shared across packages)
apps/             Frontend applications (web dashboard, mobile)
infra/            Infrastructure configs (NemoClaw sandbox Dockerfile, K8s manifests)
docs/             Phase implementation plans and design docs
```

Each package in `packages/` has its own `package.json`, `tsconfig.json`, and `src/` directory. Packages reference each other via workspace protocol (`workspace:*`).
