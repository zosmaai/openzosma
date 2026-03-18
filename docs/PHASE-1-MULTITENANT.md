# Phase 1: Multi-Instance Pi-Agent Refactor

**Location:** `../pi-mono/packages/coding-agent/`
**Duration:** 3-4 days
**Priority:** P0 (blocks all other phases)

## Goal

Make `pi-coding-agent` safe for concurrent, isolated sessions within the same Node.js process. No new features -- pure refactor. The existing TUI must continue to work identically.

This is a prerequisite for OpenZosma's orchestrator, which runs multiple agent sessions concurrently inside sandboxes.

## Background

`packages/agent/` (pi-agent-core) is already clean -- fully instance-based, zero global state. No changes needed there.

`packages/coding-agent/` has exactly 7 global state issues that cause cross-session data leakage when multiple sessions run concurrently.

## Issues and Fixes

### 1. Tool Singletons (CRITICAL)

**Files:**
- `src/core/tools/read.ts` -- `readTool` singleton
- `src/core/tools/write.ts` -- `writeTool` singleton
- `src/core/tools/edit.ts` -- `editTool` singleton
- `src/core/tools/bash.ts` -- `bashTool` singleton
- `src/core/tools/grep.ts` -- `grepTool` singleton
- `src/core/tools/find.ts` -- `findTool` singleton
- `src/core/tools/ls.ts` -- `lsTool` singleton
- `src/core/tools/index.ts:82-96` -- `codingTools`, `allTools` frozen arrays

**Problem:** Tool instances are created at module load time with `process.cwd()` baked in. All sessions in the same process share the same tools pointing to the same directory.

**Fix:**
- Factory functions (`createReadTool(cwd)`, `createBashTool(cwd)`, etc.) already exist in each tool file
- Replace `index.ts` exports: remove `codingTools` and `allTools` singletons
- Add `createToolSet(cwd: string): Tool[]` function that calls all factories with the given `cwd`
- `AgentSession` constructor calls `createToolSet(sessionCwd)` to get per-session tools

**Estimated effort:** 1-2 days (most complex change, touches many files)

### 2. Global Command Result Cache (CRITICAL)

**File:** `src/core/resolve-config-value.ts:9`

**Problem:** `commandResultCache` is a module-level `Map<string, string>`. If session A resolves a config value (e.g., running `git config user.name`), session B sees the cached result even if it has a different working directory or environment.

**Fix:**
- Option A: Add `cwd` prefix to cache keys (e.g., `"/workspace/a:git config user.name"`)
- Option B: Move cache into a per-session context object passed to `resolveConfigValue()`
- Option B is cleaner. Create a `ConfigResolver` class with an instance-level cache, or accept a `cache: Map` parameter.

**Estimated effort:** 2 hours

### 3. Global Shell Config Cache (CRITICAL)

**File:** `src/utils/shell.ts:7`

**Problem:** `cachedShellConfig` is a module-level variable. Different sessions may run in different environments (different PATH, different shell).

**Fix:**
- Make `getShellConfig()` accept an optional `cache` parameter or context object
- Or make it a method on a session-scoped utility class
- The cache is for performance (avoids re-running shell detection). Per-session caching is fine since shell config won't change mid-session.

**Estimated effort:** 2 hours

### 4. Global Timings Array (HIGH)

**File:** `src/core/timings.ts:7-8`

**Problem:** `timings: TimingEntry[]` and `lastTime: number` are module-level variables. All sessions' timing data gets mixed together, making performance analysis meaningless.

**Fix:**
- Create a `Timings` class:
  ```typescript
  class Timings {
    private entries: TimingEntry[] = []
    private lastTime: number = 0
    mark(label: string): void { ... }
    getEntries(): TimingEntry[] { ... }
  }
  ```
- Each session creates its own `Timings` instance

**Estimated effort:** 1 hour

### 5. Process.env Mutations (HIGH)

**File:** `src/main.ts:580-583`

**Problem:** `process.env.PI_OFFLINE = "true"` and `process.env.PI_SKIP_VERSION_CHECK = "true"` are set globally. This affects ALL sessions in the process.

**Fix:**
- Create a per-session flags object:
  ```typescript
  interface SessionFlags {
    offline: boolean
    skipVersionCheck: boolean
  }
  ```
- Functions that read these flags accept them as parameters instead of reading `process.env`
- `main.ts` can still set `process.env` for the TUI case (single-session process)

**Estimated effort:** 2 hours

### 6. Agent Directory Defaults (MEDIUM)

**File:** `src/config.ts:82,178,188,195`

**Problem:** `getAgentDir()` defaults to `~/.pi/agent/`. Multiple sessions would share config/state directories, causing file conflicts and data leakage.

**Fix:**
- Make `agentDir` a required parameter on `AgentSession` config (or the config object passed to it)
- Remove the fallback to `~/.pi/agent/` in the session creation path
- `main.ts` (TUI entry point) can still use the default for backwards compatibility

**Estimated effort:** 4 hours

### 7. Constructor Defaults (MEDIUM)

**Various files** where constructors default to `process.cwd()` or `getAgentDir()`.

**Problem:** Makes it easy to accidentally create sessions without explicit directory scoping.

**Fix:**
- Make `cwd` and `agentDir` required parameters (no defaults) in the session factory
- Type system enforces callers provide explicit values
- Existing TUI code path provides `process.cwd()` explicitly

**Estimated effort:** 1 hour

### Non-Issue: Theme (SKIP)

**File:** `src/theme/theme.ts`

Global theme on `globalThis`. This is TUI-only and irrelevant for headless agent sessions. No change needed.

## New Entry Point

After all fixes, add a factory function:

```typescript
// src/core/isolated-session.ts

export interface IsolatedSessionConfig {
  cwd: string
  agentDir: string
  streamFn: StreamFn
  sessionId?: string
  model?: string
  systemPrompt?: string
  tools?: string[]  // tool names to enable
  flags?: SessionFlags
}

export function createIsolatedSession(config: IsolatedSessionConfig): AgentSession {
  const tools = createToolSet(config.cwd)
  const timings = new Timings()
  const configResolver = new ConfigResolver()
  // ... wire everything together with per-session instances
  return new AgentSession({ ...config, tools, timings, configResolver })
}
```

This is the function OpenZosma's orchestrator will call for each new sandbox session.

## Verification

1. `npm run check` in pi-mono root passes with zero errors, warnings, and infos
2. TUI still works identically (`./pi-test.sh` in tmux)
3. No behavioral changes to existing functionality
4. New `createIsolatedSession()` can be imported and called multiple times with different configs without interference

## Files Changed (Expected)

```
packages/coding-agent/src/core/tools/index.ts      -- replace singletons with factory
packages/coding-agent/src/core/tools/read.ts        -- minor (ensure factory is exported)
packages/coding-agent/src/core/tools/write.ts       -- minor
packages/coding-agent/src/core/tools/edit.ts        -- minor
packages/coding-agent/src/core/tools/bash.ts        -- minor
packages/coding-agent/src/core/tools/grep.ts        -- minor
packages/coding-agent/src/core/tools/find.ts        -- minor
packages/coding-agent/src/core/tools/ls.ts          -- minor
packages/coding-agent/src/core/resolve-config-value.ts  -- add cache parameter
packages/coding-agent/src/utils/shell.ts            -- add cache parameter
packages/coding-agent/src/core/timings.ts           -- Timings class
packages/coding-agent/src/core/session.ts           -- accept per-session deps
packages/coding-agent/src/main.ts                   -- extract env mutations
packages/coding-agent/src/config.ts                 -- required agentDir param
packages/coding-agent/src/core/isolated-session.ts  -- NEW: factory function
```
