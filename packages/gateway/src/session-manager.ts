import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { AgentProvider, AgentSession } from "@openzosma/agents"
import { PiAgentProvider } from "@openzosma/agents"
import type { Pool } from "@openzosma/db"
import { agentConfigQueries } from "@openzosma/db"
import { createLogger } from "@openzosma/logger"
import type { KBFileEntry, OrchestratorSessionManager } from "@openzosma/orchestrator"
import type { FileArtifact, GatewayEvent, Session, SessionMessage, WsAttachment } from "./types.js"

const log = createLogger({ component: "gateway" })

/**
 * Per-session state holding the agent session and gateway-level metadata.
 * Used only in local (non-orchestrator) mode.
 */
interface SessionState {
	agentSession: AgentSession
	session: Session
	/** Absolute path to the session's workspace directory. Only set in local mode. */
	workspaceDir?: string
}

/**
 * Gateway session manager.
 *
 * Operates in two modes:
 *
 * 1. **Local mode** (default/deprecated): Runs pi-agent directly in-process.
 *    No file management features. Serves as development fallback only.
 *
 * 2. **Orchestrator mode**: Delegates session lifecycle and message routing
 *    to the OrchestratorSessionManager, which proxies to sandbox-server
 *    instances running inside per-user OpenShell sandboxes. File management
 *    is handled entirely in the sandbox via the user-files API.
 *
 * The mode is determined by whether an `orchestrator` is passed to the
 * constructor. When the orchestrator is present, all operations that involve
 * agent execution are delegated. Session metadata is still tracked locally
 * for the gateway's own needs (SSE subscriptions, message history).
 */
export class SessionManager {
	private sessions = new Map<string, SessionState>()
	private emitters = new Map<string, EventEmitter>()
	private provider: AgentProvider
	private pool: Pool | undefined
	private orchestrator: OrchestratorSessionManager | undefined
	/**
	 * Mutex that serializes the critical section between setting PI_MEMORY_DIR
	 * (process.env) and the jiti extension import that reads it. Without this,
	 * concurrent createSession() calls would race on the shared env var.
	 */
	private initLock: Promise<void> = Promise.resolve()

	constructor(opts?: {
		provider?: AgentProvider
		pool?: Pool
		orchestrator?: OrchestratorSessionManager
	}) {
		this.provider = opts?.provider ?? new PiAgentProvider()
		this.pool = opts?.pool
		this.orchestrator = opts?.orchestrator
	}

	private getEmitter(sessionId: string): EventEmitter {
		let emitter = this.emitters.get(sessionId)
		if (!emitter) {
			emitter = new EventEmitter()
			this.emitters.set(sessionId, emitter)
		}
		return emitter
	}

	/**
	 * Create a new session.
	 *
	 * @param id           Optional session ID -- if already exists, the existing session is returned.
	 * @param agentConfigId Optional agent config UUID.
	 * @param resolvedConfig Pre-fetched agent config fields.
	 * @param userId        User ID (required in orchestrator mode).
	 */
	async createSession(
		id?: string,
		agentConfigId?: string,
		resolvedConfig?: { provider?: string; model?: string; systemPrompt?: string | null; toolsEnabled?: string[] },
		userId?: string,
	): Promise<Session> {
		// If the caller supplies an ID that already exists, return the existing session.
		if (id) {
			const existing = this.sessions.get(id)
			if (existing) return existing.session
		}

		const sessionId = id ?? randomUUID()

		// -- Orchestrator mode --
		if (this.orchestrator) {
			if (!userId) {
				throw new Error(
					"userId is required in orchestrator mode. " +
						"Ensure the caller extracts userId from the auth context before calling createSession.",
				)
			}

			let orchSession: Awaited<ReturnType<typeof this.orchestrator.createSession>>
			try {
				orchSession = await this.orchestrator.createSession(userId, {
					sessionId,
					agentConfigId,
					resolvedConfig,
				})
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.error("orchestrator.createSession threw", { error: msg })
				throw err
			}

			// Create a local Session object for gateway-level tracking
			const session: Session = {
				id: orchSession.id,
				agentConfigId,
				createdAt: orchSession.createdAt,
				messages: [],
			}

			// Store a stub SessionState (no local agentSession in orchestrated mode)
			this.sessions.set(session.id, {
				agentSession: null as unknown as AgentSession,
				session,
			})

			return session
		}

		// -- Local mode (deprecated) --
		const session: Session = {
			id: sessionId,
			agentConfigId,
			createdAt: new Date().toISOString(),
			messages: [],
		}

		const workspaceRoot = resolve(process.env.OPENZOSMA_WORKSPACE ?? join(process.cwd(), "workspace"))
		const sessionDir = join(workspaceRoot, "sessions", session.id)
		mkdirSync(sessionDir, { recursive: true })

		// Memory must persist across sessions. Use a stable directory keyed by
		// agent config, or a shared default when no config is specified.
		const memoryKey = agentConfigId ?? "default"
		const memoryDir = join(workspaceRoot, "agents", memoryKey, "memory")
		mkdirSync(memoryDir, { recursive: true })
		// Symlink the knowledge base into the session directory so that agent
		// edits are immediately visible in the dashboard and vice-versa.
		const kbRoot = resolve(process.env.KNOWLEDGE_BASE_PATH || join(process.cwd(), "../../.knowledge-base"))
		mkdirSync(kbRoot, { recursive: true })
		symlinkSync(kbRoot, join(sessionDir, ".knowledge-base"))

		let agentConfig: { provider?: string; model?: string; systemPrompt?: string; toolsEnabled?: string[] } = {}
		if (resolvedConfig) {
			agentConfig = { ...resolvedConfig, systemPrompt: resolvedConfig.systemPrompt ?? undefined }
		} else if (agentConfigId && this.pool) {
			const config = await agentConfigQueries.getAgentConfig(this.pool, agentConfigId)
			if (config) {
				agentConfig = {
					provider: config.provider,
					model: config.model,
					systemPrompt: config.systemPrompt ?? undefined,
					toolsEnabled: config.toolsEnabled,
				}
			}
		}

		// Serialize session creation so that process.env.PI_MEMORY_DIR (set by
		// bootstrapMemory, read by pi-memory at jiti import time) is not clobbered
		// by a concurrent session before the extension loader reads it.
		const prevLock = this.initLock
		let releaseLock: () => void
		this.initLock = new Promise<void>((r) => {
			releaseLock = r
		})
		await prevLock

		const agentSession = this.provider.createSession({
			sessionId: session.id,
			workspaceDir: sessionDir,
			memoryDir,
			...agentConfig,
		})

		// Release the lock after a short delay to let the extension loader read
		// PI_MEMORY_DIR. The env var is set synchronously in the PiAgentSession
		// constructor (which ran above), and the jiti import happens in the async
		// init inside that constructor. A 100ms window is conservative.
		setTimeout(() => releaseLock!(), 100)

		this.sessions.set(session.id, { agentSession, session, workspaceDir: sessionDir })
		return session
	}

	getSession(id: string): Session | undefined {
		return this.sessions.get(id)?.session
	}

	deleteSession(id: string): boolean {
		if (this.orchestrator) {
			const session = this.sessions.get(id)
			if (session) {
				// Fire-and-forget orchestrator cleanup
				void this.orchestrator.deleteSession(id)
			}
		}
		this.emitters.delete(id)
		return this.sessions.delete(id)
	}

	/**
	 * Destroy the sandbox for a user.
	 *
	 * Only meaningful in orchestrator mode. Delegates to
	 * OrchestratorSessionManager.destroyUserSandbox(), which tears down
	 * the OpenShell pod, removes the DB record, and clears session state.
	 * The next request from this user will create a fresh sandbox.
	 *
	 * In local mode this is a no-op (returns false).
	 */
	async destroySandbox(userId: string): Promise<boolean> {
		if (!this.orchestrator) {
			return false
		}

		// Remove local gateway session state for this user
		for (const [id] of this.sessions) {
			const orchSession = this.orchestrator.getSession(id)
			if (orchSession && orchSession.userId === userId) {
				this.emitters.delete(id)
				this.sessions.delete(id)
			}
		}

		await this.orchestrator.destroyUserSandbox(userId)
		return true
	}

	/**
	 * Get sandbox info for a user.
	 *
	 * Returns the sandbox DB record in orchestrator mode, or null in local mode.
	 */
	async getSandboxInfo(userId: string): Promise<{
		sandboxName: string
		status: string
		createdAt: string
		lastActiveAt: string
	} | null> {
		if (!this.orchestrator) {
			return null
		}

		const record = await this.orchestrator.getUserSandboxInfo(userId)
		if (!record) {
			return null
		}

		return {
			sandboxName: record.sandboxName,
			status: record.status,
			createdAt: record.createdAt.toISOString(),
			lastActiveAt: record.lastActiveAt.toISOString(),
		}
	}

	// -----------------------------------------------------------------------
	// Knowledge base sync
	// -----------------------------------------------------------------------

	/**
	 * Push a file to the user's sandbox knowledge base.
	 *
	 * In orchestrator mode, delegates to OrchestratorSessionManager.pushKBFile().
	 * In local mode, this is a no-op (symlinks handle sync automatically).
	 */
	async pushKBFile(userId: string, path: string, content: string): Promise<void> {
		if (!this.orchestrator) return
		await this.orchestrator.pushKBFile(userId, path, content)
	}

	/**
	 * Delete a file from the user's sandbox knowledge base.
	 *
	 * In orchestrator mode, delegates to OrchestratorSessionManager.deleteKBFile().
	 * In local mode, this is a no-op (symlinks handle sync automatically).
	 */
	async deleteKBFile(userId: string, path: string): Promise<void> {
		if (!this.orchestrator) return
		await this.orchestrator.deleteKBFile(userId, path)
	}

	/**
	 * Pull all KB files from the user's sandbox.
	 *
	 * In orchestrator mode, returns files from the sandbox's .knowledge-base/.
	 * In local mode, returns an empty array (symlinks mean the files are
	 * already on the local filesystem).
	 */
	async pullKB(userId: string): Promise<KBFileEntry[]> {
		if (!this.orchestrator) return []
		return this.orchestrator.pullKB(userId)
	}

	/**
	 * Subscribe to real-time events for a session. Yields events emitted by
	 * any concurrent `sendMessage` call on this session. Keeps the generator
	 * open until `signal` is aborted (client disconnects).
	 *
	 * Used by the SSE endpoint. Will be replaced by Valkey pub/sub in Phase 4.
	 */
	async *subscribe(sessionId: string, signal?: AbortSignal): AsyncGenerator<GatewayEvent> {
		const emitter = this.getEmitter(sessionId)
		const queue: GatewayEvent[] = []
		let notify: (() => void) | undefined

		const onEvent = (event: GatewayEvent) => {
			queue.push(event)
			notify?.()
		}
		const onAbort = () => notify?.()

		emitter.on("event", onEvent)
		signal?.addEventListener("abort", onAbort, { once: true })

		try {
			while (!signal?.aborted) {
				if (queue.length > 0) {
					yield queue.shift()!
				} else {
					await new Promise<void>((r) => {
						notify = r
					})
					notify = undefined
				}
			}
		} finally {
			emitter.off("event", onEvent)
			signal?.removeEventListener("abort", onAbort)
		}
	}

	/**
	 * Send a user message and stream back gateway events.
	 *
	 * In orchestrator mode, delegates to the sandbox-server via the
	 * OrchestratorSessionManager. File artifacts generated by the agent
	 * are automatically copied to /workspace/user-files/ai-generated/<sessionId>/
	 * inside the sandbox (by the sandbox-server's file scanner). The gateway
	 * strips base64 content from file_output events and forwards metadata only.
	 *
	 * When attachments are provided, files are uploaded to the sandbox and the
	 * message content is prepended with file path references so the agent
	 * knows about them.
	 *
	 * @param userId Required in orchestrator mode; ignored in local mode.
	 * @param attachments Optional file attachments from the chat input.
	 */
	async *sendMessage(
		sessionId: string,
		content: string,
		signal?: AbortSignal,
		userId?: string,
		attachments?: WsAttachment[],
	): AsyncGenerator<GatewayEvent> {
		// -- Orchestrator mode --
		if (this.orchestrator) {
			if (!userId) {
				yield { type: "error", error: "userId is required in orchestrator mode" }
				return
			}

			// Ensure session exists in gateway state
			if (!this.sessions.has(sessionId)) {
				try {
					await this.createSession(sessionId, undefined, undefined, userId)
				} catch (err) {
					const message = err instanceof Error ? err.message : "Failed to create session"
					yield { type: "error", error: message }
					return
				}
			}

			const state = this.sessions.get(sessionId)
			if (!state) {
				yield { type: "error", error: `Session ${sessionId} could not be initialized` }
				return
			}

			// Store user message
			const userMsg: SessionMessage = {
				id: randomUUID(),
				role: "user",
				content,
				createdAt: new Date().toISOString(),
			}
			state.session.messages.push(userMsg)

			// Upload attachments to the sandbox and prepend file references
			let augmentedContent = content
			if (attachments && attachments.length > 0) {
				try {
					const filesToUpload = attachments.map((att) => {
						const { buffer } = this.decodeDataUrl(att.dataUrl)
						return {
							filename: att.filename,
							content: buffer.toString("base64"),
							dir: "user-files/uploads",
						}
					})
					const uploaded = await this.orchestrator.uploadFiles(userId, filesToUpload)
					if (uploaded.length > 0) {
						const fileRefs = uploaded.map((u) => `- ${u.path}`).join("\n")
						augmentedContent = `The user has attached the following files to this message (available in the workspace):\n${fileRefs}\n\n${content}`
					}
				} catch (err) {
					log.warn("Failed to upload attachments to sandbox", {
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			let lastAssistantText = ""
			let lastMessageId: string | undefined
			const emitter = this.getEmitter(sessionId)

			for await (const event of this.orchestrator.sendMessage(sessionId, userId, augmentedContent, signal)) {
				const gatewayEvent: GatewayEvent = event as GatewayEvent

				if (event.type === "message_start") {
					lastMessageId = event.id
					lastAssistantText = ""
				} else if (event.type === "message_update" && event.text) {
					lastAssistantText += event.text
				}

				// Intercept file_output events from sandbox: strip base64 content
				// and forward metadata only. The artifacts are already stored in
				// the sandbox filesystem under user-files/ai-generated/<sessionId>/.
				if (gatewayEvent.type === "file_output" && gatewayEvent.artifacts) {
					const cleanArtifacts: FileArtifact[] = gatewayEvent.artifacts.map((a) => ({
						filename: a.filename,
						mediatype: a.mediatype,
						sizebytes: a.sizebytes,
					}))
					const cleanEvent: GatewayEvent = {
						type: "file_output",
						artifacts: cleanArtifacts,
					}
					emitter.emit("event", cleanEvent)
					yield cleanEvent
					continue
				}

				emitter.emit("event", gatewayEvent)
				yield gatewayEvent
			}

			if (lastAssistantText) {
				const assistantMsg: SessionMessage = {
					id: lastMessageId ?? randomUUID(),
					role: "assistant",
					content: lastAssistantText,
					createdAt: new Date().toISOString(),
				}
				state.session.messages.push(assistantMsg)
			}

			return
		}

		// -- Local mode (deprecated) --
		// Auto-create session on first message if it doesn't exist yet.
		if (!this.sessions.has(sessionId)) {
			await this.createSession(sessionId)
		}

		const state = this.sessions.get(sessionId)
		if (!state) {
			yield { type: "error", error: `Session ${sessionId} could not be initialized` }
			return
		}
		const { agentSession, session, workspaceDir } = state

		if (!workspaceDir) {
			yield { type: "error", error: "Local mode session not properly initialized" }
			return
		}

		// Store user message
		const userMsg: SessionMessage = {
			id: randomUUID(),
			role: "user",
			content,
			createdAt: new Date().toISOString(),
		}
		session.messages.push(userMsg)

		// Write attachments to workspace and prepend file references (local mode)
		const augmentedContent =
			attachments && attachments.length > 0 ? this.writeAttachmentsToDir(attachments, workspaceDir, content) : content

		let lastAssistantText = ""
		let lastMessageId: string | undefined
		const emitter = this.getEmitter(sessionId)

		for await (const event of agentSession.sendMessage(augmentedContent, signal)) {
			const gatewayEvent: GatewayEvent = event as GatewayEvent

			if (event.type === "message_start") {
				lastMessageId = event.id
				lastAssistantText = ""
			} else if (event.type === "message_update" && event.text) {
				lastAssistantText += event.text
			}

			emitter.emit("event", gatewayEvent)
			yield gatewayEvent
		}

		// Store assistant message for session history
		if (lastAssistantText) {
			const assistantMsg: SessionMessage = {
				id: lastMessageId ?? randomUUID(),
				role: "assistant",
				content: lastAssistantText,
				createdAt: new Date().toISOString(),
			}
			session.messages.push(assistantMsg)
		}
	}

	/**
	 * Decode a data URL into a Buffer and MIME type.
	 *
	 * Accepts both `data:<mime>;base64,<data>` and raw base64 strings.
	 */
	private decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
		const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
		if (match) {
			return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] }
		}
		// Fallback: assume raw base64
		return { buffer: Buffer.from(dataUrl, "base64"), mimeType: "application/octet-stream" }
	}

	/**
	 * Write attachment files to a directory and return the content string
	 * prepended with file path references.
	 *
	 * Files are placed at `<targetDir>/user-uploads/<filename>`. Duplicate
	 * filenames are disambiguated with a numeric suffix.
	 *
	 * Used only in local mode (deprecated).
	 *
	 * @returns The augmented content string with file references prepended.
	 */
	private writeAttachmentsToDir(attachments: WsAttachment[], targetDir: string, content: string): string {
		if (attachments.length === 0) return content

		const uploadsDir = join(targetDir, "user-uploads")
		mkdirSync(uploadsDir, { recursive: true })

		const writtenPaths: string[] = []
		const usedNames = new Set<string>()

		for (const attachment of attachments) {
			try {
				const { buffer } = this.decodeDataUrl(attachment.dataUrl)

				// Disambiguate duplicate filenames
				let filename = attachment.filename
				if (usedNames.has(filename)) {
					const ext = filename.includes(".") ? `.${filename.split(".").pop()}` : ""
					const base = ext ? filename.slice(0, -ext.length) : filename
					let counter = 1
					while (usedNames.has(`${base}-${counter}${ext}`)) counter++
					filename = `${base}-${counter}${ext}`
				}
				usedNames.add(filename)

				const filePath = join(uploadsDir, filename)
				mkdirSync(dirname(filePath), { recursive: true })
				writeFileSync(filePath, buffer)
				writtenPaths.push(`user-uploads/${filename}`)
			} catch (err) {
				log.warn(`Failed to write attachment ${attachment.filename}`, {
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		if (writtenPaths.length === 0) return content

		const fileRefs = writtenPaths.map((p) => `- ${p}`).join("\n")
		const prefix = `The user has attached the following files to this message (available in the workspace):\n${fileRefs}\n\n`
		return prefix + content
	}
}
