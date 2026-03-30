import { randomUUID } from "node:crypto"
import type { AgentStreamEvent } from "@openzosma/agents"
import type { Pool } from "@openzosma/db"
import { agentConfigQueries, userSandboxQueries } from "@openzosma/db"
import type { UserSandbox } from "@openzosma/db"
import { createLogger } from "@openzosma/logger"
import type { SandboxHttpClient } from "./sandbox-http-client.js"
import type { SandboxManager } from "./sandbox-manager.js"
import type { KBFileEntry, OrchestratorSession, UserFileEntry } from "./types.js"

const log = createLogger({ component: "orchestrator" })

/**
 * Orchestrator session manager.
 *
 * Sits between the gateway and per-user sandboxes. Each user has one
 * persistent sandbox (managed by SandboxManager). Sessions are conversations
 * that run inside a user's sandbox via the sandbox-server HTTP API.
 *
 * This replaces the gateway's in-process SessionManager. Instead of running
 * pi-agent directly, it proxies requests to the sandbox-server running
 * inside each user's OpenShell sandbox.
 */
export class OrchestratorSessionManager {
	private readonly pool: Pool
	private readonly sandboxManager: SandboxManager
	/** In-memory session registry: sessionId -> session metadata. */
	private readonly sessions = new Map<string, OrchestratorSession>()

	constructor(pool: Pool, sandboxManager: SandboxManager) {
		this.pool = pool
		this.sandboxManager = sandboxManager
	}

	// -----------------------------------------------------------------------
	// Session lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Create a session for a user. Ensures the user's sandbox is running,
	 * then creates a session inside it via the sandbox-server HTTP API.
	 */
	async createSession(
		userId: string,
		opts?: {
			sessionId?: string
			agentConfigId?: string
			resolvedConfig?: {
				provider?: string
				model?: string
				systemPrompt?: string | null
				toolsEnabled?: string[]
			}
		},
	): Promise<OrchestratorSession> {
		const sessionId = opts?.sessionId ?? randomUUID()

		// Return existing session if re-requested
		const existing = this.sessions.get(sessionId)
		if (existing) return existing

		// Ensure the user's sandbox is up and ready
		const sandboxState = await this.sandboxManager.ensureSandbox(userId)

		// Resolve agent config
		let agentConfig: {
			provider?: string
			model?: string
			systemPrompt?: string
			toolsEnabled?: string[]
		} = {}

		if (opts?.resolvedConfig) {
			agentConfig = {
				...opts.resolvedConfig,
				systemPrompt: opts.resolvedConfig.systemPrompt ?? undefined,
			}
		} else if (opts?.agentConfigId && this.pool) {
			const config = await agentConfigQueries.getAgentConfig(this.pool, opts.agentConfigId)
			if (config) {
				agentConfig = {
					provider: config.provider,
					model: config.model,
					systemPrompt: config.systemPrompt ?? undefined,
					toolsEnabled: config.toolsEnabled,
				}
			}
		}

		// Create the session inside the sandbox via HTTP
		const client = this.sandboxManager.getHttpClient(userId)
		await client.createSession({
			sessionId,
			provider: agentConfig.provider,
			model: agentConfig.model,
			systemPrompt: agentConfig.systemPrompt,
			toolsEnabled: agentConfig.toolsEnabled,
			agentConfigId: opts?.agentConfigId,
		})

		// Track the session in the sandbox state
		sandboxState.activeSessions.add(sessionId)

		const session: OrchestratorSession = {
			id: sessionId,
			userId,
			sandboxName: sandboxState.sandboxName,
			agentConfigId: opts?.agentConfigId,
			createdAt: new Date().toISOString(),
		}

		this.sessions.set(sessionId, session)
		await this.sandboxManager.touchSandbox(userId)

		return session
	}

	/**
	 * Get session metadata by ID.
	 */
	getSession(sessionId: string): OrchestratorSession | undefined {
		return this.sessions.get(sessionId)
	}

	/**
	 * Delete a session. Removes it from the sandbox and from the registry.
	 */
	async deleteSession(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId)
		if (!session) return false

		// Remove from sandbox
		try {
			const client = this.sandboxManager.getHttpClient(session.userId)
			await client.deleteSession(sessionId)
		} catch {
			// Sandbox may be gone -- clean up locally regardless
		}

		// Remove from sandbox state tracking
		const sandboxState = this.sandboxManager.getSandboxState(session.userId)
		if (sandboxState) {
			sandboxState.activeSessions.delete(sessionId)
		}

		this.sessions.delete(sessionId)
		return true
	}

	// -----------------------------------------------------------------------
	// Sandbox lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Destroy the sandbox for a user. Removes the OpenShell pod, DB record,
	 * and all in-memory session state associated with the user.
	 *
	 * The next request from this user will trigger a fresh sandbox creation
	 * (which includes uploading the latest knowledge base content).
	 */
	async destroyUserSandbox(userId: string): Promise<void> {
		// Remove all sessions belonging to this user from the registry
		for (const [sessionId, session] of this.sessions) {
			if (session.userId === userId) {
				this.sessions.delete(sessionId)
			}
		}

		await this.sandboxManager.destroySandbox(userId)
	}

	// -----------------------------------------------------------------------
	// Message handling
	// -----------------------------------------------------------------------

	/**
	 * Send a message to a session and stream back agent events.
	 *
	 * Routes the message to the sandbox-server running inside the user's
	 * sandbox and proxies the SSE event stream back.
	 *
	 * If the initial fetch fails (e.g. port forward died), attempts to
	 * re-establish the port forward and retries once before giving up.
	 */
	async *sendMessage(
		sessionId: string,
		userId: string,
		content: string,
		signal?: AbortSignal,
	): AsyncGenerator<AgentStreamEvent> {
		// Auto-create session if it doesn't exist
		if (!this.sessions.has(sessionId)) {
			try {
				await this.createSession(userId, { sessionId })
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				yield { type: "error", error: message }
				return
			}
		}

		const session = this.sessions.get(sessionId)
		if (!session) {
			log.error("Session could not be initialized", { sessionId })
			yield { type: "error", error: `Session ${sessionId} could not be initialized` }
			return
		}

		// Touch the sandbox to reset idle timer
		await this.sandboxManager.touchSandbox(session.userId)

		// Get the HTTP client for this user's sandbox
		let client: SandboxHttpClient
		try {
			client = this.sandboxManager.getHttpClient(session.userId)
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to connect to sandbox"
			yield { type: "error", error: message }
			return
		}

		// Proxy the SSE stream from the sandbox-server.
		// If the fetch fails (connection refused / port forward dead),
		// try to re-establish the forward and retry once.
		let eventCount = 0
		try {
			for await (const event of client.sendMessage(sessionId, content, signal)) {
				eventCount++
				yield event
			}
		} catch (err) {
			if (signal?.aborted) return

			const message = err instanceof Error ? err.message : "Unknown sandbox error"
			const isFetchFailure = message === "fetch failed" || message.includes("ECONNREFUSED")

			if (isFetchFailure && eventCount === 0) {
				// No events were received yet, so we can safely retry.
				// The port forward likely died; attempt to re-establish it.
				log.warn("Fetch failed before any events, attempting port forward recovery", {
					sessionId,
					sandbox: session.sandboxName,
				})

				const recovered = await this.sandboxManager.refreshPortForward(session.userId)
				if (recovered) {
					// Get a fresh client with the (potentially same) port
					try {
						client = this.sandboxManager.getHttpClient(session.userId)
					} catch {
						log.error("Failed to get HTTP client after recovery")
						yield { type: "error", error: message }
						return
					}

					// Retry once
					try {
						for await (const event of client.sendMessage(sessionId, content, signal)) {
							eventCount++
							yield event
						}
					} catch (retryErr) {
						if (!signal?.aborted) {
							const retryMessage = retryErr instanceof Error ? retryErr.message : "Unknown sandbox error"
							log.error("sendMessage failed after port forward recovery", { error: retryMessage })
							yield { type: "error", error: retryMessage }
						}
					}
				} else {
					log.error("Port forward recovery failed", { error: message })
					yield { type: "error", error: message }
				}
			} else {
				log.error("sendMessage error", { error: message })
				yield { type: "error", error: message }
			}
		}

		// Touch again after the turn completes
		await this.sandboxManager.touchSandbox(session.userId)
	}

	/**
	 * Cancel an active turn for a session.
	 */
	async cancelSession(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId)
		if (!session) return false

		try {
			const client = this.sandboxManager.getHttpClient(session.userId)
			return await client.cancelSession(sessionId)
		} catch {
			return false
		}
	}

	// -----------------------------------------------------------------------
	// Queries
	// -----------------------------------------------------------------------

	/**
	 * List all sessions for a user.
	 */
	getSessionsForUser(userId: string): OrchestratorSession[] {
		const result: OrchestratorSession[] = []
		for (const session of this.sessions.values()) {
			if (session.userId === userId) {
				result.push(session)
			}
		}
		return result
	}

	/**
	 * Get the total number of active sessions.
	 */
	get activeSessionCount(): number {
		return this.sessions.size
	}

	/**
	 * Get the sandbox DB record for a user.
	 * Returns null if the user has no sandbox.
	 */
	async getUserSandboxInfo(userId: string): Promise<UserSandbox | null> {
		return userSandboxQueries.getByUserId(this.pool, userId)
	}

	// -----------------------------------------------------------------------
	// Knowledge base sync
	// -----------------------------------------------------------------------

	/**
	 * Push a file to the sandbox's knowledge base.
	 * Ensures the sandbox is running before writing.
	 */
	async pushKBFile(userId: string, path: string, content: string): Promise<void> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		await client.writeKBFile(path, content)
	}

	/**
	 * Delete a file from the sandbox's knowledge base.
	 * No-op if the sandbox is not running.
	 */
	async deleteKBFile(userId: string, path: string): Promise<void> {
		const state = this.sandboxManager.getSandboxState(userId)
		if (!state) return // No sandbox running, nothing to delete
		const client = this.sandboxManager.getHttpClient(userId)
		await client.deleteKBFile(path)
	}

	/**
	 * Pull all KB files from the sandbox.
	 * Returns the full content of every file in the sandbox's .knowledge-base/.
	 */
	async pullKB(userId: string): Promise<KBFileEntry[]> {
		const state = this.sandboxManager.getSandboxState(userId)
		if (!state) return []
		const client = this.sandboxManager.getHttpClient(userId)
		return client.listKBFiles()
	}

	// -----------------------------------------------------------------------
	// File upload
	// -----------------------------------------------------------------------

	/**
	 * Upload files into a user's sandbox workspace.
	 *
	 * Ensures the sandbox is running, then uploads the files via the
	 * sandbox-server HTTP API. Each file is base64-encoded.
	 *
	 * @returns Array of successfully uploaded file paths within the sandbox workspace.
	 */
	async uploadFiles(
		userId: string,
		files: Array<{ filename: string; content: string; dir?: string }>,
	): Promise<Array<{ filename: string; path: string }>> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.uploadFiles(files)
	}

	// -----------------------------------------------------------------------
	// User files (sandbox filesystem passthrough)
	// -----------------------------------------------------------------------

	/**
	 * Get the recursive directory tree of all user files in the sandbox.
	 * Creates the sandbox eagerly if it doesn't exist yet.
	 */
	async getUserFilesTree(userId: string): Promise<UserFileEntry[]> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.getUserFilesTree()
	}

	/**
	 * List contents of a single directory within user-files.
	 */
	async listUserFiles(userId: string, path = "/"): Promise<UserFileEntry[]> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.listUserFiles(path)
	}

	/**
	 * Download a file from user-files. Returns the raw Response.
	 */
	async downloadUserFile(userId: string, path: string): Promise<Response> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.downloadUserFile(path)
	}

	/**
	 * Upload files to a directory within user-files.
	 */
	async uploadUserFiles(
		userId: string,
		dirPath: string,
		files: Array<{ filename: string; content: string }>,
	): Promise<UserFileEntry[]> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.uploadUserFiles(dirPath, files)
	}

	/**
	 * Create a folder within user-files.
	 */
	async createUserFolder(userId: string, path: string): Promise<UserFileEntry> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.createUserFolder(path)
	}

	/**
	 * Rename or move a file/folder within user-files.
	 */
	async renameUserFile(userId: string, from: string, to: string): Promise<UserFileEntry> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.renameUserFile(from, to)
	}

	/**
	 * Delete a file or folder within user-files.
	 */
	async deleteUserFile(userId: string, path: string): Promise<void> {
		await this.sandboxManager.ensureSandbox(userId)
		const client = this.sandboxManager.getHttpClient(userId)
		return client.deleteUserFile(path)
	}
}
