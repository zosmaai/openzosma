import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { Pool } from "@openzosma/db"
import { userSandboxQueries } from "@openzosma/db"
import type { UserSandbox } from "@openzosma/db"
import { createLogger } from "@openzosma/logger"
import { OpenShellClient } from "@openzosma/sandbox"
import { SandboxNotFoundError, SandboxNotReadyError } from "@openzosma/sandbox"
import type { SandboxConfig } from "@openzosma/sandbox"
import { SandboxHttpClient } from "./sandbox-http-client.js"
import type { OrchestratorConfig, SandboxState } from "./types.js"
import { DEFAULT_CONFIG } from "./types.js"

const log = createLogger({ component: "orchestrator" })

/**
 * Find the monorepo root by walking up from cwd looking for pnpm-workspace.yaml.
 * Falls back to cwd if not found.
 */
function findWorkspaceRoot(): string {
	let dir = process.cwd()
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
			return dir
		}
		dir = dirname(dir)
	}
	return process.cwd()
}

/**
 * Manages per-user persistent sandboxes.
 *
 * Each user gets exactly one sandbox. The sandbox manager handles:
 * - Creating new sandboxes (OpenShell + DB record)
 * - Ensuring a sandbox is ready before routing sessions to it
 * - Suspending idle sandboxes
 * - Resuming suspended sandboxes
 * - Destroying sandboxes
 * - Providing HTTP clients to talk to sandbox-servers
 */
export class SandboxManager {
	private readonly pool: Pool
	private readonly openshell: OpenShellClient
	private readonly config: OrchestratorConfig
	/** In-memory cache of sandbox state, keyed by userId. */
	private readonly sandboxes = new Map<string, SandboxState>()
	/** Lock map to prevent concurrent sandbox creation for the same user. */
	private readonly locks = new Map<string, Promise<SandboxState>>()
	/** Ports currently allocated to sandboxes. */
	private readonly allocatedPorts = new Set<number>()
	/**
	 * Optional hook called after sandbox creation succeeds and before the
	 * sandbox is marked "ready". The hook receives the sandbox name, userId,
	 * and the OpenShellClient so it can upload user files into the sandbox.
	 *
	 * Set via the constructor. Used by the gateway to mount user-uploaded
	 * files into /workspace/user-files/ at sandbox creation time.
	 */
	private readonly onSandboxReady?: (ctx: {
		sandboxName: string
		userId: string
		openshell: OpenShellClient
	}) => Promise<void>

	constructor(
		pool: Pool,
		opts?: {
			config?: Partial<OrchestratorConfig>
			openshell?: OpenShellClient
			onSandboxReady?: (ctx: { sandboxName: string; userId: string; openshell: OpenShellClient }) => Promise<void>
		},
	) {
		this.pool = pool
		this.openshell = opts?.openshell ?? new OpenShellClient()
		this.config = { ...DEFAULT_CONFIG, ...opts?.config }
		this.onSandboxReady = opts?.onSandboxReady
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Ensure a sandbox exists and is ready for the given user.
	 * If the sandbox doesn't exist, creates it. If it's suspended, resumes it.
	 * Returns the sandbox state.
	 */
	async ensureSandbox(userId: string): Promise<SandboxState> {
		// Check in-memory cache first
		const cached = this.sandboxes.get(userId)
		if (cached && cached.phase === "ready") {
			cached.lastActivityAt = Date.now()
			return cached
		}

		// Prevent concurrent sandbox creation for the same user
		const existingLock = this.locks.get(userId)
		if (existingLock) {
			return existingLock
		}

		const promise = this.ensureSandboxInternal(userId)
		this.locks.set(userId, promise)
		try {
			return await promise
		} finally {
			this.locks.delete(userId)
		}
	}

	/**
	 * Get an HTTP client for the sandbox belonging to a user.
	 * The sandbox must be in "ready" state.
	 */
	getHttpClient(userId: string): SandboxHttpClient {
		const state = this.sandboxes.get(userId)
		if (!state) {
			throw new SandboxNotFoundError(`sandbox for user ${userId}`)
		}
		if (state.phase !== "ready") {
			throw new SandboxNotReadyError(state.sandboxName, state.phase)
		}

		// Due to OpenShell's network namespace isolation, the pod IP is
		// unreachable from the host. We always use localhost with the
		// forwarded port established by `openshell forward start`.
		const port = state.forwardedPort ?? this.config.agentPort
		return new SandboxHttpClient("localhost", port)
	}

	/**
	 * Record activity on a user's sandbox (updates lastActivityAt).
	 */
	async touchSandbox(userId: string): Promise<void> {
		const state = this.sandboxes.get(userId)
		if (state) {
			state.lastActivityAt = Date.now()
			await userSandboxQueries.touch(this.pool, state.recordId)
		}
	}

	/**
	 * Re-establish port forwarding for a user's sandbox.
	 *
	 * Called when a fetch to the sandbox fails, indicating the port forward
	 * may have died (e.g. SSH tunnel timeout, OpenShell gateway restart).
	 * Checks whether the sandbox pod is still alive and restarts the forward.
	 *
	 * Returns true if the forward was successfully re-established.
	 */
	async refreshPortForward(userId: string): Promise<boolean> {
		const state = this.sandboxes.get(userId)
		if (!state || state.phase !== "ready" || !state.forwardedPort) {
			return false
		}

		// Verify the sandbox pod is still alive
		const info = await this.openshell.get(state.sandboxName)
		if (!info || info.phase !== "ready") {
			log.warn("Sandbox pod is no longer ready, cannot refresh forward", {
				sandbox: state.sandboxName,
				phase: info?.phase,
			})
			return false
		}

		// Stop the old forward (may already be dead, ignore errors)
		try {
			await this.openshell.forwardStop(state.forwardedPort, state.sandboxName)
		} catch {
			// Forward already gone
		}

		// Re-establish the forward on the same port
		try {
			await this.openshell.forwardStart(state.sandboxName, state.forwardedPort)
			log.info("Port forward re-established", {
				sandbox: state.sandboxName,
				port: state.forwardedPort,
			})
			return true
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.error("Failed to re-establish port forward", {
				sandbox: state.sandboxName,
				port: state.forwardedPort,
				error: message,
			})
			return false
		}
	}

	/**
	 * Suspend a user's sandbox (stop the pod but keep the DB record).
	 */
	async suspendSandbox(userId: string): Promise<void> {
		const state = this.sandboxes.get(userId)
		if (!state || state.phase !== "ready") return

		state.phase = "suspended"
		await userSandboxQueries.updateStatus(this.pool, state.recordId, "suspended")

		// Stop port forwarding before deleting the sandbox
		if (state.forwardedPort) {
			try {
				await this.openshell.forwardStop(state.forwardedPort, state.sandboxName)
			} catch {
				// Forward may already be gone
			}
		}

		// Delete the OpenShell sandbox (the DB record persists for resume)
		try {
			await this.openshell.delete(state.sandboxName)
		} catch {
			// Already gone or unreachable -- not a problem for suspension
		}

		if (state.forwardedPort) {
			this.releasePort(state.forwardedPort)
		}
		this.sandboxes.delete(userId)
	}

	/**
	 * Destroy a user's sandbox completely (OpenShell + DB record).
	 */
	async destroySandbox(userId: string): Promise<void> {
		const state = this.sandboxes.get(userId)
		if (!state) {
			// Try DB lookup
			const record = await userSandboxQueries.getByUserId(this.pool, userId)
			if (record) {
				// Best-effort: stop port forward on the default agent port
				try {
					await this.openshell.forwardStop(this.config.agentPort, record.sandboxName)
				} catch {
					// Forward may not exist
				}
				try {
					await this.openshell.delete(record.sandboxName)
				} catch {
					// Already gone
				}
				await userSandboxQueries.deleteById(this.pool, record.id)
			}
			return
		}

		// Stop port forwarding before deleting the sandbox
		if (state.forwardedPort) {
			try {
				await this.openshell.forwardStop(state.forwardedPort, state.sandboxName)
			} catch {
				// Forward may already be gone
			}
		}

		try {
			await this.openshell.delete(state.sandboxName)
		} catch {
			// Already gone
		}

		await userSandboxQueries.deleteById(this.pool, state.recordId)
		if (state.forwardedPort) {
			this.releasePort(state.forwardedPort)
		}
		this.sandboxes.delete(userId)
	}

	/**
	 * Get the current sandbox state for a user (from in-memory cache).
	 */
	getSandboxState(userId: string): SandboxState | undefined {
		return this.sandboxes.get(userId)
	}

	/**
	 * Find and suspend sandboxes that have been idle longer than the threshold.
	 * Called periodically by the health check loop.
	 */
	async suspendIdleSandboxes(): Promise<string[]> {
		const suspended: string[] = []
		const threshold = Date.now() - this.config.idleSuspendThresholdMs

		for (const [userId, state] of this.sandboxes) {
			if (state.phase === "ready" && state.activeSessions.size === 0 && state.lastActivityAt < threshold) {
				await this.suspendSandbox(userId)
				suspended.push(userId)
			}
		}

		return suspended
	}

	/**
	 * Run a health check on all active sandboxes.
	 * Returns the list of sandbox names that failed the check.
	 */
	async healthCheckAll(): Promise<string[]> {
		const unhealthy: string[] = []

		for (const [userId, state] of this.sandboxes) {
			if (state.phase !== "ready") continue

			const port = state.forwardedPort ?? this.config.agentPort
			const healthy = await this.openshell.healthCheck(state.sandboxName, port)
			if (!healthy) {
				unhealthy.push(state.sandboxName)
				// Mark as error in DB and cache
				state.phase = "error"
				await userSandboxQueries.updateStatus(this.pool, state.recordId, "error")
				if (state.forwardedPort) {
					this.releasePort(state.forwardedPort)
				}
				this.sandboxes.delete(userId)
			}
		}

		return unhealthy
	}

	/**
	 * Get the total number of active (non-suspended) sandboxes.
	 */
	get activeSandboxCount(): number {
		return this.sandboxes.size
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private async ensureSandboxInternal(userId: string): Promise<SandboxState> {
		const record = await userSandboxQueries.getByUserId(this.pool, userId)
		if (record) {
			return this.handleExistingRecord(userId, record)
		}

		return this.createNewSandbox(userId)
	}

	private async handleExistingRecord(userId: string, record: UserSandbox): Promise<SandboxState> {
		// Check if the OpenShell sandbox still exists
		const info = await this.openshell.get(record.sandboxName)

		if (info && info.phase === "ready") {
			// Sandbox exists and is ready. Recover the port from metadata
			// and re-establish port forwarding.
			const port = this.recoverPort(record)

			try {
				await this.openshell.forwardStart(record.sandboxName, port)
			} catch {
				// Forward may already be active from a previous run
			}

			const state: SandboxState = {
				userId,
				sandboxName: record.sandboxName,
				recordId: record.id,
				phase: "ready",
				podIp: info.podIp,
				forwardedPort: port,
				activeSessions: new Set(),
				lastActivityAt: Date.now(),
			}
			this.sandboxes.set(userId, state)
			await userSandboxQueries.updateStatus(this.pool, record.id, "ready")
			return state
		}

		if (info && (info.phase === "creating" || info.phase === "provisioning")) {
			// Sandbox is still starting up -- wait for it
			await userSandboxQueries.updateStatus(this.pool, record.id, "provisioning")
			const ready = await this.openshell.waitReady(record.sandboxName, this.config.sandboxReadyTimeoutMs)

			const port = this.recoverPort(record)

			try {
				await this.openshell.forwardStart(record.sandboxName, port)
			} catch {
				// Forward may already be active
			}

			const state: SandboxState = {
				userId,
				sandboxName: record.sandboxName,
				recordId: record.id,
				phase: "ready",
				podIp: ready.podIp,
				forwardedPort: port,
				activeSessions: new Set(),
				lastActivityAt: Date.now(),
			}
			this.sandboxes.set(userId, state)
			await userSandboxQueries.updateStatus(this.pool, record.id, "ready")
			return state
		}

		// Sandbox is gone (suspended/deleted/error) -- recreate it
		if (info) {
			try {
				await this.openshell.delete(record.sandboxName)
			} catch {
				// Already gone
			}
		}

		return this.createSandboxForRecord(userId, record)
	}

	private async createNewSandbox(userId: string): Promise<SandboxState> {
		// Enforce quota
		if (this.config.maxSandboxes > 0 && this.sandboxes.size >= this.config.maxSandboxes) {
			throw new Error(
				`Maximum sandbox limit reached (${this.config.maxSandboxes}). Cannot create sandbox for user ${userId}.`,
			)
		}

		const sandboxName = this.generateSandboxName(userId)

		// Create DB record first
		const record = await userSandboxQueries.create(this.pool, userId, sandboxName)

		return this.createSandboxForRecord(userId, record)
	}

	private async createSandboxForRecord(userId: string, record: UserSandbox): Promise<SandboxState> {
		const port = this.allocatePort()
		const config: SandboxConfig = {
			image: this.config.sandboxImage,
			// Resolve the policy path to absolute. If already absolute, use as-is.
			// Otherwise resolve relative to the monorepo root (not cwd, which
			// may be packages/gateway/ when started via tsx watch).
			policyPath: isAbsolute(this.config.defaultPolicyPath)
				? this.config.defaultPolicyPath
				: resolve(findWorkspaceRoot(), this.config.defaultPolicyPath),
			agentPort: port,
			// Invoke via sh so it works even if the execute bit is missing.
			// The entrypoint lives under /app/ which is in the policy read_only
			// allowlist; placing it at / would be blocked by Landlock.
			command: ["/bin/sh", "/app/entrypoint.sh", String(port)],
		}

		// Env vars to inject after the sandbox is running.
		// The CLI does not support --env; we write a dotenv file post-creation.
		// The entrypoint waits for /sandbox/.env before starting the server,
		// so these vars (including LLM API keys) are available at boot time.
		const sandboxEnv: Record<string, string> = {
			SANDBOX_USER_ID: userId,
			SANDBOX_NAME: record.sandboxName,
			SANDBOX_SERVER_PORT: String(port),
		}

		// Forward LLM provider keys from the gateway's environment.
		// The sandbox-server uses pi-coding-agent which reads these directly.
		const envKeysToForward = [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"GOOGLE_GENERATIVE_AI_API_KEY",
			"OPENZOSMA_MODEL_PROVIDER",
			"OPENZOSMA_MODEL_ID",
			"OPENZOSMA_LOCAL_MODEL_URL",
			"OPENZOSMA_LOCAL_MODEL_ID",
			"OPENZOSMA_LOCAL_MODEL_NAME",
			"OPENZOSMA_LOCAL_MODEL_API_KEY",
			"OPENZOSMA_LOCAL_MODEL_CONTEXT_WINDOW",
			"OPENZOSMA_LOCAL_MODEL_MAX_TOKENS",
		]
		for (const key of envKeysToForward) {
			const value = process.env[key]
			if (value) {
				sandboxEnv[key] = value
			}
		}

		await userSandboxQueries.updateStatus(this.pool, record.id, "provisioning")

		try {
			// create() with a command spawns the CLI in the background and polls
			// waitReady() internally, returning once the sandbox is Ready.
			log.info("Creating OpenShell sandbox", { sandbox: record.sandboxName })
			const info = await this.openshell.create(record.sandboxName, config)
			log.info("Sandbox ready", { sandbox: record.sandboxName, phase: info.phase })

			// Start port forwarding so the orchestrator can reach the sandbox-server.
			// The local and remote port must be the same (OpenShell CLI constraint).
			log.info("Starting port forward", { port, sandbox: record.sandboxName })
			await this.openshell.forwardStart(record.sandboxName, port)

			// Inject environment variables into the running sandbox.
			// This MUST succeed -- the entrypoint waits for /sandbox/.env
			// before starting the server. If injection fails, the sandbox
			// will hang for 120s then start without LLM keys.
			log.info("Injecting .env", { sandbox: record.sandboxName, varCount: Object.keys(sandboxEnv).length })
			await this.openshell.injectEnv(record.sandboxName, sandboxEnv)
			log.info(".env injected successfully")

			// Upload knowledge base content into the sandbox so the agent can
			// access KB files the user created via the dashboard.  This is
			// best-effort -- the sandbox still functions without KB content.
			const kbRoot = resolve(process.env.KNOWLEDGE_BASE_PATH || join(findWorkspaceRoot(), ".knowledge-base"))
			if (existsSync(kbRoot)) {
				try {
					log.info("Uploading knowledge base", { from: kbRoot, sandbox: record.sandboxName })
					await this.openshell.uploadDir(record.sandboxName, kbRoot, "/workspace/")
					log.info("Knowledge base uploaded successfully")
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					log.warn("Failed to upload knowledge base (non-fatal)", { error: msg })
				}
			}

			// Run the onSandboxReady hook to upload user files into the sandbox.
			// This is best-effort -- the sandbox still functions without user files.
			if (this.onSandboxReady) {
				try {
					await this.onSandboxReady({
						sandboxName: record.sandboxName,
						userId,
						openshell: this.openshell,
					})
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					log.warn("onSandboxReady hook failed (non-fatal)", { error: msg })
				}
			}

			// Wait for the sandbox-server to become healthy. After env
			// injection the entrypoint sources .env and starts Node. We
			// poll the /health endpoint until it responds (or timeout).
			log.info("Waiting for sandbox-server health", { port })
			await this.waitForHealthy(record.sandboxName, port, 60_000)
			log.info("Sandbox is healthy", { sandbox: record.sandboxName })

			const state: SandboxState = {
				userId,
				sandboxName: record.sandboxName,
				recordId: record.id,
				phase: "ready",
				podIp: info.podIp,
				forwardedPort: port,
				activeSessions: new Set(),
				lastActivityAt: Date.now(),
			}

			this.sandboxes.set(userId, state)
			await userSandboxQueries.updateStatus(this.pool, record.id, "ready")

			// Persist the allocated port in DB metadata so we can recover it
			// if the orchestrator restarts while the sandbox is still running.
			await userSandboxQueries.updateMetadata(this.pool, record.id, {
				...record.metadata,
				agentPort: port,
			})

			return state
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.error("Sandbox creation failed", { sandbox: record.sandboxName, error: message })
			this.releasePort(port)
			await userSandboxQueries.updateStatus(this.pool, record.id, "error")
			throw err
		}
	}

	private generateSandboxName(userId: string): string {
		// Use a shortened user ID for readability, with a prefix
		const shortId = userId
			.replace(/[^a-zA-Z0-9]/g, "")
			.slice(0, 12)
			.toLowerCase()
		const suffix = Math.random().toString(36).slice(2, 6)
		return `oz-${shortId}-${suffix}`
	}

	// -----------------------------------------------------------------------
	// Health polling
	// -----------------------------------------------------------------------

	/**
	 * Poll the sandbox-server's /health endpoint until it responds.
	 *
	 * After `injectEnv()` uploads `/sandbox/.env`, the entrypoint sources it
	 * and starts the Node.js server. This typically takes 2-5 seconds. We
	 * poll until the health endpoint responds 200 or the timeout expires.
	 */
	private async waitForHealthy(sandboxName: string, port: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs
		const pollInterval = 2_000

		while (Date.now() < deadline) {
			const healthy = await this.openshell.healthCheck(sandboxName, port)
			if (healthy) return
			await new Promise((resolve) => setTimeout(resolve, pollInterval))
		}

		throw new Error(`Sandbox ${sandboxName} server did not become healthy within ${timeoutMs}ms (port ${port})`)
	}

	// -----------------------------------------------------------------------
	// Port allocation
	// -----------------------------------------------------------------------

	/**
	 * Recover the agent port for an existing sandbox from its DB metadata.
	 *
	 * If metadata contains `agentPort`, we reuse it (the sandbox-server is
	 * already listening on that port). Otherwise, fall back to allocating a
	 * new port -- this is a best-effort path for sandboxes created before
	 * port metadata was persisted.
	 */
	private recoverPort(record: UserSandbox): number {
		const stored = record.metadata?.agentPort
		if (typeof stored === "number" && stored > 0) {
			// Mark the port as allocated so it won't be reused
			this.allocatedPorts.add(stored)
			return stored
		}
		// Fallback: allocate a fresh port. This may not match the port the
		// sandbox-server is actually listening on if the sandbox was created
		// with a different port, but it's the best we can do without metadata.
		return this.allocatePort()
	}

	/**
	 * Starting port for sandbox allocation.
	 *
	 * We use a high range (10000-19999) to avoid conflicts with well-known
	 * ports and the OpenShell gateway (8080).
	 */
	private static readonly PORT_RANGE_START = 10000
	private static readonly PORT_RANGE_END = 19999

	/**
	 * Allocate a unique local port for a sandbox.
	 *
	 * OpenShell's `forward start <port>` maps localhost:<port> to
	 * sandbox:<port>, so the local and remote port must be the same.
	 * Each sandbox-server is configured to listen on its allocated port.
	 */
	private allocatePort(): number {
		for (let port = SandboxManager.PORT_RANGE_START; port <= SandboxManager.PORT_RANGE_END; port++) {
			if (!this.allocatedPorts.has(port)) {
				this.allocatedPorts.add(port)
				return port
			}
		}
		throw new Error(`No available ports in range ${SandboxManager.PORT_RANGE_START}-${SandboxManager.PORT_RANGE_END}`)
	}

	/**
	 * Release a previously allocated port.
	 */
	private releasePort(port: number): void {
		this.allocatedPorts.delete(port)
	}
}
