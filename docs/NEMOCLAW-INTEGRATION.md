# NemoClaw Integration Plan

## Overview

[NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) is the sandbox runtime for OpenZosma. Each user session gets a NemoClaw-powered sandboxed agent running inside an [OpenShell](https://github.com/NVIDIA/OpenShell) sandbox with Landlock + seccomp + network namespace isolation.

NemoClaw is a **direct dependency**, not just a pattern to follow. OpenZosma wraps NemoClaw into a platform: managing multiple sandbox instances, routing messages from channels (Web, Slack, WhatsApp), and handling auth/usage/agent configuration at the organization level.

## Architecture

```
Orchestrator
    |
    |-- NemoClaw CLI / API
    |       |
    |       |-- Sandbox A (OpenShell)
    |       |     ├── pi-coding-agent (gRPC server on :50052)
    |       |     ├── Landlock + seccomp isolation
    |       |     ├── Deny-by-default network policies
    |       |     └── Inference routed through OpenShell gateway
    |       |
    |       |-- Sandbox B (OpenShell)
    |       |     └── ...
    |       |
    |       └── Sandbox C (OpenShell)
    |             └── ...
    |
    └── Sandbox Pool Manager
          ├── Pre-warming (configurable pool size)
          ├── Health checks
          └── Allocation / release
```

## NemoClaw Components

NemoClaw has two components relevant to integration:

### 1. TypeScript Plugin (`nemoclaw/`)

The NemoClaw npm package provides:
- CLI commands: `nemoclaw onboard`, `nemoclaw <name> connect`, `nemoclaw <name> status`, `nemoclaw <name> logs`
- Programmatic API for sandbox lifecycle management
- Blueprint resolution and application

Dependencies: `commander`, `json5`, `tar`, `yaml`, `openclaw@2026.3.11`

### 2. Blueprint (`nemoclaw-blueprint/`)

Defines the sandbox environment:
- Docker image to use (our `infra/openshell/Dockerfile`)
- Policy files (filesystem, network, process restrictions)
- Lifecycle hooks: resolve -> verify digest -> plan -> apply -> status

## How It Replaces `packages/sandbox/`

The current `packages/sandbox/` is a stub. In Phase 4, it becomes the **NemoClaw integration layer**:

| Current (stub) | Phase 4 (NemoClaw) |
|---|---|
| Placeholder package | Wraps NemoClaw TypeScript API |
| No sandbox management | Provisions/destroys sandboxes via NemoClaw CLI |
| No isolation | Landlock + seccomp + network namespace via OpenShell |
| No inference routing | Agent -> OpenShell gateway -> LLM provider |
| Mocked for testing | Real sandboxes in staging, mocked in unit tests |

### `packages/sandbox/` Responsibilities (Phase 4)

```typescript
// Conceptual API (not final)
interface SandboxManager {
  // Lifecycle
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;
  
  // Pool management
  prewarm(count: number): Promise<void>;
  allocate(sessionId: string): Promise<Sandbox>;
  release(sandboxId: string): Promise<void>;
  
  // Health
  healthCheck(sandboxId: string): Promise<HealthStatus>;
  
  // Communication
  connect(sandboxId: string): Promise<GrpcBidiStream>;
}
```

Internally, this calls NemoClaw's TypeScript API:
- `create()` -> `nemoclaw onboard` + custom blueprint pointing to `infra/openshell/Dockerfile`
- `destroy()` -> NemoClaw sandbox teardown
- `connect()` -> gRPC client to sandbox's `:50052`

## Sandbox Lifecycle

```
1. Orchestrator.createSession()
   └── SandboxManager.allocate()
       ├── If pre-warmed sandbox available -> assign it
       └── If not -> SandboxManager.create()
           └── NemoClaw onboard with OpenZosma blueprint
               ├── Build/pull sandbox image (infra/openshell/Dockerfile)
               ├── Apply sandbox policy (filesystem, network, process)
               ├── Inject credentials via OpenShell credential provider
               └── Start pi-coding-agent with gRPC server

2. Orchestrator.sendMessage()
   └── gRPC bidi stream to sandbox:50052
       ├── Send AgentMessage
       └── Receive stream of AgentEvent

3. Orchestrator.endSession()
   └── SandboxManager.release()
       ├── Disconnect gRPC stream
       ├── Return to pool (if pool not full) or destroy
       └── NemoClaw sandbox teardown
```

## Sandbox Policy

Based on NemoClaw's `openclaw-sandbox.yaml` format. OpenZosma provides a default policy that can be customized via the settings table.

### Default Policy

```yaml
filesystem_policy:
  read_only:
    - /app          # Agent code (immutable)
    - /usr
    - /lib
  read_write:
    - /workspace    # Agent working directory
    - /tmp/agent    # Temporary files

process:
  run_as_user: sandbox

network_policies:
  # Deny-by-default. Only allow what the agent needs.
  node:
    - host: "api.openai.com"
      port: 443
      protocol: tcp
    - host: "api.anthropic.com"
      port: 443
      protocol: tcp
    - host: "generativelanguage.googleapis.com"
      port: 443
      protocol: tcp
  # git needs network for clone/fetch
  git:
    - host: "github.com"
      port: 443
      protocol: tcp
    - host: "github.com"
      port: 22
      protocol: tcp
```

### Policy Customization

Network policies and inference routing are hot-reloadable at runtime (NemoClaw feature). Filesystem and process policies are locked at sandbox creation.

Customization is done via the `settings` table:
- `sandbox.network_policies` -- JSON blob overriding default network rules
- `sandbox.inference_provider` -- Which LLM provider to route through
- `sandbox.inference_model` -- Default model for the agent

## Inference Routing

NemoClaw supports routing inference requests through the OpenShell gateway rather than having the agent talk to LLM APIs directly. This provides:

- **Centralized API key management** -- keys never enter the sandbox
- **Usage tracking** -- all inference calls go through a single point
- **Model switching** -- change the model without restarting sandboxes
- **Rate limiting** -- enforce per-session token budgets at the gateway level

```
Agent (in sandbox)
    └── LLM request -> OpenShell gateway (host network)
        └── Forward to configured provider (OpenAI, Anthropic, etc.)
```

For OpenZosma, this means:
1. LLM API keys are configured at the organization level (env vars or settings)
2. Keys are injected into the OpenShell gateway, not the sandbox
3. The sandbox's network policy only allows connections to the OpenShell gateway for inference
4. Token usage is tracked by the orchestrator via the gateway's metrics

## Development vs Production

### Development (Docker Compose)

During development (before Phase 4 is complete), sandboxes are mocked:
- `packages/sandbox/` exports a `MockSandboxManager` that runs pi-coding-agent in-process
- No NemoClaw CLI needed for gateway/orchestrator development
- Integration tests can optionally test against real NemoClaw if the CLI is installed

### Production (Kubernetes)

In production:
- NemoClaw manages real OpenShell sandboxes
- Each sandbox is an isolated K3s pod
- The orchestrator connects to sandboxes over the pod network via gRPC
- Sandbox images are pre-built and stored in a container registry

## Implementation Plan (Phase 4)

1. **Install NemoClaw as dependency** in `packages/sandbox/`
2. **Create OpenZosma blueprint** at `infra/openshell/` (Dockerfile + policy YAML)
3. **Implement SandboxManager** wrapping NemoClaw TypeScript API
4. **Implement sandbox pool** with pre-warming, allocation, health checks
5. **Wire orchestrator** to use SandboxManager instead of mocks
6. **Integration tests** with real NemoClaw sandboxes
7. **Document sandbox policy customization** for operators

## References

- [NemoClaw GitHub](https://github.com/NVIDIA/NemoClaw) -- Source code and documentation
- [NemoClaw Architecture](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html) -- Component overview
- [OpenShell](https://github.com/NVIDIA/OpenShell) -- Underlying sandbox infrastructure
- [openclaw-sandbox.yaml](https://github.com/NVIDIA/NemoClaw/blob/main/nemoclaw-blueprint/policies/openclaw-sandbox.yaml) -- Reference sandbox policy
