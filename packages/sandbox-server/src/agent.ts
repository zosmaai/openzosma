import { randomUUID } from "node:crypto"
import type { AgentSession, AgentStreamEvent } from "@openzosma/agents"
import { PiAgentProvider } from "@openzosma/agents"
import { buildArtifactEvents, copyArtifactsToUserFiles, createSnapshot, detectChanges } from "./file-scanner.js"
import type { FileSnapshot } from "./file-scanner.js"

const WORKSPACE_DIR = process.env.OPENZOSMA_WORKSPACE ?? "/workspace"

/** Extended event type that includes file_output. */
export type SandboxEvent =
	| AgentStreamEvent
	| { type: "file_output"; artifacts: { filename: string; mediatype: string; sizebytes: number; content?: string }[] }

/**
 * Derive a human-readable, filesystem-safe folder name from the first user
 * message in a session. A short suffix from the session ID ensures uniqueness.
 *
 * Examples:
 *   "Clone the openzosma repo"        -> "clone-the-openzosma-repo-3e52d2"
 *   "Generate a sales report for Q1"  -> "generate-a-sales-report-for-q1-a7dd63"
 *   ""                                -> "3e52d2e5" (fallback)
 */
const sanitizeFolderName = (message: string, sessionId: string): string => {
	const sanitized = message
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 50)
		.replace(/-$/, "")

	if (!sanitized) return sessionId.slice(0, 8)
	return `${sanitized}-${sessionId.slice(0, 6)}`
}

/**
 * Manages agent sessions inside the sandbox.
 *
 * Each sandbox can host multiple concurrent sessions (e.g. a user may have
 * several chat conversations open). The agent provider runs in-process
 * (inside the sandbox container), backed by pi-coding-agent.
 *
 * After each tool call, the workspace is scanned for new/changed files.
 * These are copied to user-files/ai-generated/<label>/ and metadata is
 * emitted as `file_output` events so the gateway can notify the frontend.
 */
export class SandboxAgentManager {
	private provider = new PiAgentProvider()
	private sessions = new Map<string, AgentSession>()
	private snapshots = new Map<string, Map<string, FileSnapshot>>()
	/** Human-readable folder name per session, derived from the first user message. */
	private sessionLabels = new Map<string, string>()

	/**
	 * Create a new agent session.
	 */
	createSession(opts?: {
		sessionId?: string
		provider?: string
		model?: string
		systemPrompt?: string
		toolsEnabled?: string[]
	}): string {
		const sessionId = opts?.sessionId ?? randomUUID()

		const agentSession = this.provider.createSession({
			sessionId,
			workspaceDir: WORKSPACE_DIR,
			provider: opts?.provider,
			model: opts?.model,
			systemPrompt: opts?.systemPrompt,
			toolsEnabled: opts?.toolsEnabled,
		})

		this.sessions.set(sessionId, agentSession)
		return sessionId
	}

	/**
	 * Send a message to an existing session and yield streamed events.
	 *
	 * After each tool_call_end event, the workspace is scanned for new/changed
	 * files. Changed files are copied to user-files and metadata is emitted.
	 */
	async *sendMessage(sessionId: string, content: string, signal?: AbortSignal): AsyncGenerator<SandboxEvent> {
		const session = this.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session ${sessionId} not found`)
		}

		// Derive folder label from first message in the session
		if (!this.sessionLabels.has(sessionId)) {
			this.sessionLabels.set(sessionId, sanitizeFolderName(content, sessionId))
		}

		// Take initial snapshot for artifact detection
		let snapshot = this.snapshots.get(sessionId) ?? createSnapshot(WORKSPACE_DIR)

		for await (const event of session.sendMessage(content, signal)) {
			yield event

			// After a tool call ends, scan for new output files
			if (event.type === "tool_call_end") {
				const result = this.scanForArtifacts(sessionId, snapshot)
				if (result) {
					snapshot = result.newSnapshot
					yield { type: "file_output", artifacts: result.artifacts }
				}
			}
		}

		// Final scan after the turn completes to catch stragglers
		const finalResult = this.scanForArtifacts(sessionId, snapshot)
		if (finalResult) {
			snapshot = finalResult.newSnapshot
			yield { type: "file_output", artifacts: finalResult.artifacts }
		}

		// Persist snapshot for next turn
		this.snapshots.set(sessionId, snapshot)
	}

	/**
	 * Scan workspace for changed files, copy them to user-files, and build artifact event payloads.
	 */
	private scanForArtifacts(
		sessionId: string,
		previousSnapshot: Map<string, FileSnapshot>,
	): {
		newSnapshot: Map<string, FileSnapshot>
		artifacts: { filename: string; mediatype: string; sizebytes: number; content?: string }[]
	} | null {
		const { newSnapshot, changedFiles } = detectChanges(WORKSPACE_DIR, previousSnapshot)
		if (changedFiles.length === 0) return null

		// Copy detected files to /workspace/user-files/ai-generated/<label>/
		const folderName = this.sessionLabels.get(sessionId) ?? sessionId
		copyArtifactsToUserFiles(folderName, changedFiles)

		const artifacts = buildArtifactEvents(changedFiles)
		if (artifacts.length === 0) return null

		return { newSnapshot, artifacts }
	}

	/**
	 * Check if a session exists.
	 */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId)
	}

	/**
	 * Delete a session.
	 */
	deleteSession(sessionId: string): boolean {
		this.snapshots.delete(sessionId)
		this.sessionLabels.delete(sessionId)
		return this.sessions.delete(sessionId)
	}

	/**
	 * List all active session IDs.
	 */
	listSessions(): string[] {
		return [...this.sessions.keys()]
	}
}
