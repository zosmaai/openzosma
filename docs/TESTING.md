# Testing Strategy

## Overview

OpenZosma uses [Vitest](https://vitest.dev/) as the test framework across all packages. Tests are organized by scope: unit, integration, and end-to-end.

## Conventions

### File Organization

```
packages/<name>/
├── src/
│   └── ...
└── test/
    ├── unit/
    │   └── *.test.ts
    └── integration/
        └── *.test.ts
```

- Test files are named `*.test.ts`
- Tests live in `test/` directories at the package root
- Subdirectories (`unit/`, `integration/`) separate test scopes
- Each test file corresponds to a source module or feature

### Running Tests

```bash
# Run tests for a specific package (from package root)
cd packages/gateway
npx tsx ../../node_modules/vitest/dist/cli.js --run

# Run a specific test file
npx tsx ../../node_modules/vitest/dist/cli.js --run test/unit/auth-middleware.test.ts
```

Tests are NOT run via `pnpm run test` at the repo root during development. Run them from the package directory.

### Vitest Configuration

Each package that has tests includes a `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
```

## Test Scopes

### Unit Tests

Test individual functions and modules in isolation. No external dependencies (no database, no Redis, no network).

**Target packages and areas:**

| Package | What to test |
|---|---|
| `auth` | RBAC permission checks, API key hashing/verification, scope validation |
| `grpc` | Protobuf serialization/deserialization, message construction helpers |
| `gateway` | Request validation, route handler logic (mocked orchestrator), auth middleware |
| `orchestrator` | Session state machine transitions, sandbox allocation logic, quota enforcement |
| `a2a` | Agent Card generation, JSON-RPC request/response parsing, task state mapping |
| `db` | Query builder correctness (parameterization, SQL generation) |

**Mocking strategy:**
- Use Vitest's built-in `vi.mock()` and `vi.fn()` for dependencies
- Mock database queries, gRPC clients, and external services
- Never mock the module under test

### Integration Tests

Test interactions between modules and external infrastructure. Require running services.

**Infrastructure requirements:**
- PostgreSQL (via `docker compose up postgres`)
- Valkey (via `docker compose up valkey`)
- RabbitMQ (via `docker compose up rabbitmq`)

**Target areas:**

| Area | What to test |
|---|---|
| Database queries | Run actual SQL against Docker PostgreSQL, verify schema, migrations, CRUD |
| Auth flows | Full Better Auth signup/login flow against PostgreSQL |
| gRPC round-trips | Gateway -> Orchestrator gRPC calls with real protobuf serialization |
| Pub/Sub | Valkey pub/sub message delivery and fan-out |
| Job queue | RabbitMQ publish/consume cycle |

**Graceful skip pattern:**

Integration tests check for infrastructure availability and skip if unavailable:

```typescript
import { describe, it, beforeAll } from "vitest";
import { Pool } from "pg";

let pool: Pool;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL not set, skipping integration tests");
    return;
  }
  pool = new Pool({ connectionString: url });
  try {
    await pool.query("SELECT 1");
  } catch {
    console.log("PostgreSQL not available, skipping integration tests");
    pool = undefined!;
    return;
  }
});

describe("user queries", () => {
  it("creates and retrieves a user", async ({ skip }) => {
    if (!pool) skip();
    // ... test logic
  });
});
```

### End-to-End Tests (Phase 3+)

Full system tests exercising the complete request path: HTTP client -> Gateway -> Orchestrator -> Sandbox -> response.

These will be implemented starting in Phase 3 once the gateway is functional. They will:
- Start gateway and orchestrator as child processes
- Make real HTTP/WebSocket requests
- Verify complete response cycles
- Use a test NemoClaw sandbox (or mocked sandbox for CI)

## CI Pattern

Tests run in GitHub Actions. The CI pipeline:

1. **Lint + type check**: `pnpm run check` (runs on every PR)
2. **Unit tests**: Run without infrastructure (runs on every PR)
3. **Integration tests**: Spin up PostgreSQL, Valkey, RabbitMQ via service containers (runs on every PR)
4. **E2E tests**: Full system test with mocked sandbox (runs on merge to main)

```yaml
# Example CI service containers (for integration tests)
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_DB: openzosma_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - 5432:5432
  valkey:
    image: valkey/valkey:8-alpine
    ports:
      - 6379:6379
```

## Coverage

No strict coverage thresholds enforced initially. Focus on testing critical paths:
- Auth and RBAC (security-critical)
- Session state machine (correctness-critical)
- gRPC serialization (interop-critical)
- Database queries (data integrity)

Coverage reports can be generated with:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run --coverage
```
