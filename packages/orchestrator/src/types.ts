import type { AgentStreamEvent } from "@openzosma/agents"
import type { SandboxPhase } from "@openzosma/sandbox"

// ---------------------------------------------------------------------------
// Orchestrator configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
	/** Container image for sandbox-server. */
	sandboxImage: string
	/** Path to the default OpenShell policy YAML on the host. */
	defaultPolicyPath: string
	/** Port the sandbox-server listens on inside the sandbox. */
	agentPort: number
	/** Timeout (ms) to wait for a sandbox to become ready. */
	sandboxReadyTimeoutMs: number
	/** Idle threshold (ms) before a sandbox is suspended. */
	idleSuspendThresholdMs: number
	/** Interval (ms) between health check sweeps. */
	healthCheckIntervalMs: number
	/** Maximum concurrent sandboxes. 0 = unlimited. */
	maxSandboxes: number
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
	sandboxImage: "openzosma/sandbox-server:v0.1.0",
	defaultPolicyPath: "infra/openshell/policies/default.yaml",
	agentPort: 3000,
	sandboxReadyTimeoutMs: 300_000,
	idleSuspendThresholdMs: 30 * 60 * 1000, // 30 minutes
	healthCheckIntervalMs: 60_000,
	maxSandboxes: 0,
}

// ---------------------------------------------------------------------------
// Sandbox state (in-memory, augments the DB record)
// ---------------------------------------------------------------------------

export interface SandboxState {
	/** User ID owning this sandbox. */
	userId: string
	/** OpenShell sandbox name. */
	sandboxName: string
	/** DB record ID. */
	recordId: string
	/** Current phase from OpenShell. */
	phase: SandboxPhase
	/** Internal pod IP when ready. */
	podIp?: string
	/** Local port forwarded to the sandbox's agent port via `openshell forward`. */
	forwardedPort?: number
	/** Active session IDs inside this sandbox. */
	activeSessions: Set<string>
	/** Last time any activity was recorded. */
	lastActivityAt: number
}

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export interface OrchestratorSession {
	/** Session ID. */
	id: string
	/** User ID that owns the session. */
	userId: string
	/** Sandbox name where this session runs. */
	sandboxName: string
	/** Agent config ID (optional). */
	agentConfigId?: string
	/** When the session was created. */
	createdAt: string
}

// ---------------------------------------------------------------------------
// HTTP client types (sandbox-server communication)
// ---------------------------------------------------------------------------

export interface SandboxHealthResponse {
	status: string
	sessions: number
	uptime: number
}

export interface SandboxCreateSessionRequest {
	sessionId?: string
	provider?: string
	model?: string
	systemPrompt?: string
	toolsEnabled?: string[]
	agentConfigId?: string
}

export interface SandboxCreateSessionResponse {
	sessionId: string
}

export interface SandboxSessionInfo {
	sessionId: string
	status: string
}

export interface SandboxSessionListResponse {
	sessions: string[]
}

/** Re-export for convenience. */
export type { AgentStreamEvent }

// ---------------------------------------------------------------------------
// Knowledge base types (mirror sandbox-server types)
// ---------------------------------------------------------------------------

/** A single file in the knowledge base. */
export interface KBFileEntry {
	/** Relative path within .knowledge-base/ */
	path: string
	/** UTF-8 file content */
	content: string
	/** File size in bytes */
	sizeBytes: number
	/** ISO 8601 last modified timestamp */
	modifiedAt: string
}

/** Response for GET /kb */
export interface KBListResponse {
	files: KBFileEntry[]
}

// ---------------------------------------------------------------------------
// User files types (mirror sandbox-server types)
// ---------------------------------------------------------------------------

/** A single entry (file or folder) in the user files area. */
export interface UserFileEntry {
	/** File or folder name. */
	name: string
	/** Relative path from the user-files root. */
	path: string
	/** True if this entry is a directory. */
	isFolder: boolean
	/** MIME type (null for folders). */
	mimeType: string | null
	/** Size in bytes (0 for folders). */
	sizeBytes: number
	/** ISO 8601 last modified timestamp. */
	modifiedAt: string
	/** Child entries (only present for folders in tree responses). */
	children?: UserFileEntry[]
}

/** Response for GET /user-files/tree and GET /user-files/list */
export interface UserFilesListResponse {
	entries: UserFileEntry[]
}
