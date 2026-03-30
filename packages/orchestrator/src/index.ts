// Orchestrator -- Session lifecycle, sandbox management, message routing.

// Core managers
export { SandboxManager } from "./sandbox-manager.js"
export { OrchestratorSessionManager } from "./session-manager.js"
export { SandboxHttpClient } from "./sandbox-http-client.js"

// Configuration
export { loadConfigFromEnv } from "./config.js"

// Health monitoring
export { startHealthCheckLoop } from "./health.js"

// Quota
export { checkSandboxQuota, checkSessionQuota } from "./quota.js"
export type { QuotaConfig } from "./quota.js"
export { DEFAULT_QUOTA_CONFIG } from "./quota.js"

// Types
export type {
	OrchestratorConfig,
	OrchestratorSession,
	SandboxState,
	SandboxHealthResponse,
	SandboxCreateSessionRequest,
	SandboxCreateSessionResponse,
	SandboxSessionInfo,
	SandboxSessionListResponse,
	KBFileEntry,
	KBListResponse,
	UserFileEntry,
	UserFilesListResponse,
} from "./types.js"
export { DEFAULT_CONFIG } from "./types.js"
