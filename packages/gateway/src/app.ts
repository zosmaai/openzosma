import { createHash, randomBytes } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildDefaultAgentCard } from "@openzosma/a2a"
import type { Auth } from "@openzosma/auth"
import type { Role } from "@openzosma/auth"
import type { Pool } from "@openzosma/db"
import { agentConfigQueries, apiKeyQueries } from "@openzosma/db"
import { createLogger } from "@openzosma/logger"
import type { OrchestratorSessionManager } from "@openzosma/orchestrator"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import type { HttpChannelAdapter } from "./adapters.js"
import { createPerAgentRouter } from "./a2a.js"
import { createFileRoutes } from "./file-routes.js"
import { createAuthMiddleware, requirePermission } from "./middleware/auth.js"
import type { SessionManager } from "./session-manager.js"

const log = createLogger({ component: "gateway" })

interface AppVariables {
	userId: string
	userRole: Role
	apiKeyId: string
	apiKeyScopes: string[]
}

export const createApp = (
	sessionManager: SessionManager,
	pool?: Pool,
	auth?: Auth,
	orchestrator?: OrchestratorSessionManager,
	adapters: HttpChannelAdapter[] = [],
) => {
	const app = new Hono<{ Variables: AppVariables }>()

	app.use(
		"*",
		cors({
			origin: ["http://localhost:3000"],
			allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "X-Hub-Signature-256"],
		}),
	)

	app.get("/health", (c) => c.json({ status: "ok" }))

	// Meta WhatsApp Cloud API webhooks (public; signature checked inside adapter)
	const whatsapp = adapters.find((a) => a.name === "whatsapp")
	if (whatsapp?.handleVerify && whatsapp.handleWebhook) {
		app.get("/webhooks/whatsapp", (c) => {
			const result = whatsapp.handleVerify!({
				"hub.mode": c.req.query("hub.mode") ?? undefined,
				"hub.verify_token": c.req.query("hub.verify_token") ?? undefined,
				"hub.challenge": c.req.query("hub.challenge") ?? undefined,
			})
			return c.text(result.body, result.status as 200 | 403)
		})

		app.post("/webhooks/whatsapp", async (c) => {
			const rawBody = await c.req.text()
			const signature = c.req.header("x-hub-signature-256") ?? undefined
			const result = await whatsapp.handleWebhook!(rawBody, signature)
			return c.json(result.body, result.status as 200 | 400 | 401)
		})
	}

	// A2A default Agent Card — returns the first agent config's card
	app.get("/.well-known/agent.json", async (c) => {
		if (pool) {
			const card = await buildDefaultAgentCard(pool)
			if (card) return c.json(card)
		}
		return c.json({
			name: "OpenZosma Agent",
			description: "Self-hosted AI agent platform",
			url: `${process.env.PUBLIC_URL ?? "http://localhost:4000"}/a2a/agents`,
			version: "1.0.0",
			capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
			skills: [],
			authentication: { schemes: ["bearer"] },
		})
	})

	// Better Auth routes (sign-in, sign-up, sign-out, session) — public
	if (auth) {
		app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
	}

	// A2A JSON-RPC 2.0 endpoint
	// A2A per-agent routes
	if (pool) {
		app.route("/a2a", createPerAgentRouter(sessionManager, pool))
	}

	// Auth middleware — protects all /api/v1/* routes
	if (auth && pool) {
		app.use("/api/v1/*", createAuthMiddleware(auth, pool))
	}

	// -----------------------------------------------------------------------
	// File management routes (require orchestrator for sandbox filesystem access)
	// -----------------------------------------------------------------------

	// MIME types for agent-generated artifacts (used in local-mode file routes
	// and the session artifact routes below).
	const ARTIFACT_MIME_MAP: Record<string, string> = {
		png: "image/png",
		svg: "image/svg+xml",
		pdf: "application/pdf",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		csv: "text/csv",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		txt: "text/plain",
		json: "application/json",
	}

	if (orchestrator) {
		app.route("/api/v1/files", createFileRoutes({ orchestrator }))
	} else {
		// Local mode: serve files from workspace/user-files/ai-generated/.
		// Files are copied here by scanOutputDir whenever the agent generates an artifact.

		const localUserFilesDir = (): string => {
			const root = resolve(process.env.OPENZOSMA_WORKSPACE ?? join(process.cwd(), "workspace"))
			const dir = join(root, "user-files", "ai-generated")
			mkdirSync(dir, { recursive: true })
			return dir
		}

		const LOCAL_MIME_MAP: Record<string, string> = {
			png: "image/png",
			svg: "image/svg+xml",
			pdf: "application/pdf",
			pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			csv: "text/csv",
			xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			txt: "text/plain",
			json: "application/json",
		}

		const scanLocalFiles = (dir: string) =>
			existsSync(dir)
				? readdirSync(dir)
						.filter((f) => LOCAL_MIME_MAP[f.split(".").pop() ?? ""])
						.map((filename) => {
							const ext = filename.split(".").pop() ?? ""
							return {
								name: filename,
								path: `/ai-generated/${filename}`,
								isFolder: false,
								mimeType: LOCAL_MIME_MAP[ext] ?? "application/octet-stream",
								sizeBytes: statSync(join(dir, filename)).size,
								modifiedAt: statSync(join(dir, filename)).mtime.toISOString(),
							}
						})
				: []

		app.get("/api/v1/files/tree", requirePermission("files", "read"), (c) => {
			const dir = localUserFilesDir()
			const files = scanLocalFiles(dir)
			const entries =
				files.length > 0
					? [
							{
								name: "ai-generated",
								path: "/ai-generated",
								isFolder: true,
								mimeType: null,
								sizeBytes: 0,
								modifiedAt: new Date().toISOString(),
								children: files,
							},
						]
					: []
			return c.json({ entries })
		})

		app.get("/api/v1/files/list", requirePermission("files", "read"), (c) => {
			const dir = localUserFilesDir()
			return c.json({ entries: scanLocalFiles(dir) })
		})

		app.get("/api/v1/files/download", requirePermission("files", "read"), (c) => {
			const filePath = c.req.query("path")
			if (!filePath) return c.json({ error: "path query parameter is required" }, 400)

			const dir = localUserFilesDir()
			// path is like /ai-generated/filename.pdf — strip the folder prefix
			const filename = filePath.replace(/^\/ai-generated\//, "")
			const fullPath = join(dir, filename)

			if (!existsSync(fullPath)) return c.json({ error: "File not found" }, 404)

			const ext = filename.split(".").pop() ?? ""
			const contentType = LOCAL_MIME_MAP[ext] ?? "application/octet-stream"
			const stat = statSync(fullPath)
			const download = c.req.query("download") === "true"

			c.header("Content-Type", contentType)
			c.header("Content-Length", String(stat.size))
			c.header("Cache-Control", "private, max-age=3600")
			if (download) c.header("Content-Disposition", `attachment; filename="${filename}"`)

			const stream = createReadStream(fullPath)
			return c.body(stream as unknown as ReadableStream)
		})
	}

	// -----------------------------------------------------------------------
	// Session artifact routes (local mode — serve files from session output dir)
	// -----------------------------------------------------------------------

	app.get("/api/v1/sessions/:id/artifacts/:filename", requirePermission("sessions", "read"), (c) => {
		const sessionId = c.req.param("id")
		const filename = c.req.param("filename")

		const workspaceDir = sessionManager.getSessionWorkspaceDir(sessionId)
		if (!workspaceDir) {
			return c.json({ error: "Session not found or not in local mode" }, 404)
		}

		const filePath = join(workspaceDir, "output", filename)
		if (!existsSync(filePath)) {
			return c.json({ error: "Artifact not found" }, 404)
		}

		const stat = statSync(filePath)
		const ext = filename.split(".").pop() ?? ""
		const contentType = ARTIFACT_MIME_MAP[ext] ?? "application/octet-stream"
		const download = c.req.query("download") === "true"

		c.header("Content-Type", contentType)
		c.header("Content-Length", String(stat.size))
		c.header("Cache-Control", "private, max-age=3600")
		if (download) {
			c.header("Content-Disposition", `attachment; filename="${filename}"`)
		}

		// Stream the file to avoid loading it fully into memory
		const stream = createReadStream(filePath)
		return c.body(stream as unknown as ReadableStream)
	})

	app.get("/api/v1/sessions/:id/artifacts", requirePermission("sessions", "read"), (c) => {
		const sessionId = c.req.param("id")
		const workspaceDir = sessionManager.getSessionWorkspaceDir(sessionId)
		if (!workspaceDir) {
			return c.json({ artifacts: [] })
		}

		const outputDir = join(workspaceDir, "output")
		if (!existsSync(outputDir)) {
			return c.json({ artifacts: [] })
		}

		const TRACKED_EXTS = new Set(Object.keys(ARTIFACT_MIME_MAP))
		const artifacts = readdirSync(outputDir)
			.filter((f) => TRACKED_EXTS.has(f.split(".").pop() ?? ""))
			.map((filename) => {
				const ext = filename.split(".").pop() ?? ""
				return {
					filename,
					mediatype: ARTIFACT_MIME_MAP[ext] ?? "application/octet-stream",
					sizebytes: statSync(join(outputDir, filename)).size,
				}
			})

		return c.json({ artifacts })
	})

	// -----------------------------------------------------------------------
	// Session routes
	// -----------------------------------------------------------------------

	app.post("/api/v1/sessions", requirePermission("sessions", "write"), async (c) => {
		const userId = c.get("userId") as string | undefined
		const session = await sessionManager.createSession(undefined, undefined, undefined, userId)
		return c.json({ id: session.id, createdAt: session.createdAt }, 201)
	})

	app.get("/api/v1/sessions/:id", requirePermission("sessions", "read"), (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json({
			id: session.id,
			createdAt: session.createdAt,
			messageCount: session.messages.length,
		})
	})

	app.delete("/api/v1/sessions/:id", requirePermission("sessions", "delete"), (c) => {
		const deleted = sessionManager.deleteSession(c.req.param("id"))
		if (!deleted) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json({ ok: true })
	})

	app.post("/api/v1/sessions/:id/messages", requirePermission("sessions", "write"), async (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}

		const body = await c.req.json<{ content: string }>()
		if (!body.content) {
			return c.json({ error: "content is required" }, 400)
		}

		const userId = c.get("userId") as string | undefined
		const events = []
		for await (const event of sessionManager.sendMessage(c.req.param("id"), body.content, undefined, userId)) {
			events.push(event)
		}

		const text = events
			.filter((e) => e.type === "message_update" && e.text)
			.map((e) => e.text)
			.join("")

		return c.json({ role: "assistant", content: text })
	})

	app.post("/api/v1/sessions/:id/cancel", requirePermission("sessions", "write"), async (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}
		const cancelled = await sessionManager.cancelSession(c.req.param("id"))
		return c.json({ ok: true, cancelled })
	})

	app.get("/api/v1/sessions/:id/messages", requirePermission("sessions", "read"), (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json(session.messages)
	})

	// SSE stream — subscribe to real-time events for a session.
	// Will switch to Valkey pub/sub when the orchestrator is in place.
	app.get("/api/v1/sessions/:id/stream", requirePermission("sessions", "read"), (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}

		return streamSSE(c, async (stream) => {
			const abort = new AbortController()
			stream.onAbort(() => abort.abort())

			for await (const event of sessionManager.subscribe(c.req.param("id"), abort.signal)) {
				await stream.writeSSE({ data: JSON.stringify(event) })
			}
		})
	})

	// -----------------------------------------------------------------------
	// Sandbox management routes
	// -----------------------------------------------------------------------

	app.get("/api/v1/sandbox", requirePermission("sandboxes", "read"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) {
			return c.json({ error: "userId is required (session auth only)" }, 400)
		}

		const info = await sessionManager.getSandboxInfo(userId)
		if (!info) {
			return c.json({ sandbox: null })
		}

		return c.json({ sandbox: info })
	})

	app.delete("/api/v1/sandbox", requirePermission("sandboxes", "delete"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) {
			return c.json({ error: "userId is required (session auth only)" }, 400)
		}

		const destroyed = await sessionManager.destroySandbox(userId)
		if (!destroyed) {
			return c.json({ error: "Sandbox destruction is only available in orchestrator mode" }, 400)
		}

		return c.json({ ok: true })
	})

	// -----------------------------------------------------------------------
	// Knowledge base sync routes
	// -----------------------------------------------------------------------

	/**
	 * POST /api/v1/kb/sync -- push a file change to the user's sandbox KB.
	 *
	 * Body: { action: "write" | "delete", path: string, content?: string }
	 *
	 * Used by the Next.js dashboard to sync KB edits into the running sandbox.
	 */
	app.post("/api/v1/kb/sync", requirePermission("sessions", "write"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) {
			return c.json({ error: { code: "AUTH_REQUIRED", message: "userId is required" } }, 400)
		}

		const body = await c.req.json<{ action: string; path: string; content?: string }>()
		if (!body.action || !body.path) {
			return c.json({ error: { code: "INVALID_REQUEST", message: "action and path are required" } }, 400)
		}

		try {
			if (body.action === "write") {
				if (typeof body.content !== "string") {
					return c.json({ error: { code: "INVALID_REQUEST", message: "content is required for write action" } }, 400)
				}
				await sessionManager.pushKBFile(userId, body.path, body.content)
			} else if (body.action === "delete") {
				await sessionManager.deleteKBFile(userId, body.path)
			} else {
				return c.json({ error: { code: "INVALID_REQUEST", message: `Unknown action: ${body.action}` } }, 400)
			}

			return c.json({ ok: true })
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error"
			log.error("KB sync failed", { error: message })
			return c.json({ error: { code: "SYNC_FAILED", message } }, 500)
		}
	})

	/**
	 * GET /api/v1/kb/pull -- pull all KB files from the user's sandbox.
	 *
	 * Returns { files: KBFileEntry[] } with content for each file.
	 * Used by the "Sync from Agent" button in the dashboard.
	 */
	app.get("/api/v1/kb/pull", requirePermission("sessions", "read"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) {
			return c.json({ error: { code: "AUTH_REQUIRED", message: "userId is required" } }, 400)
		}

		try {
			const files = await sessionManager.pullKB(userId)
			return c.json({ files })
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error"
			log.error("KB pull failed", { error: message })
			return c.json({ error: { code: "PULL_FAILED", message } }, 500)
		}
	})

	// -----------------------------------------------------------------------
	// Agent config routes (require DB pool)
	// -----------------------------------------------------------------------

	if (pool) {
		app.get("/api/v1/agents", requirePermission("agent_configs", "read"), async (c) => {
			const agents = await agentConfigQueries.listAgentConfigs(pool)
			return c.json({
				agents: agents.map((a) => ({
					id: a.id,
					name: a.name,
					description: a.description,
					model: a.model,
					provider: a.provider,
					skills: a.skills,
					createdAt: a.createdAt,
				})),
			})
		})

		app.get("/api/v1/agents/:id", requirePermission("agent_configs", "read"), async (c) => {
			const agent = await agentConfigQueries.getAgentConfig(pool, c.req.param("id"))
			if (!agent) {
				return c.json({ error: "Agent config not found" }, 404)
			}
			return c.json(agent)
		})
	}

	// -----------------------------------------------------------------------
	// API key routes (require DB pool)
	// -----------------------------------------------------------------------

	if (pool) {
		app.post("/api/v1/api-keys", requirePermission("api_keys", "write"), async (c) => {
			const body = await c.req.json<{ name: string; scopes?: string[]; expiresAt?: string }>()
			if (!body.name) {
				return c.json({ error: "name is required" }, 400)
			}

			const rawKey = `ozk_${randomBytes(32).toString("base64url")}`
			const keyPrefix = rawKey.slice(0, 12)
			const keyHash = createHash("sha256").update(rawKey).digest("hex")
			const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined

			const apiKey = await apiKeyQueries.createApiKey(pool, body.name, keyHash, keyPrefix, body.scopes, expiresAt)
			return c.json({ id: apiKey.id, key: rawKey }, 201)
		})

		app.get("/api/v1/api-keys", requirePermission("api_keys", "read"), async (c) => {
			const keys = await apiKeyQueries.listApiKeys(pool)
			return c.json({
				keys: keys.map((k) => ({
					id: k.id,
					name: k.name,
					keyPrefix: k.keyPrefix,
					scopes: k.scopes,
					lastUsedAt: k.lastUsedAt,
					expiresAt: k.expiresAt,
					createdAt: k.createdAt,
				})),
			})
		})

		app.delete("/api/v1/api-keys/:id", requirePermission("api_keys", "delete"), async (c) => {
			await apiKeyQueries.deleteApiKey(pool, c.req.param("id"))
			return c.json({ ok: true })
		})
	}

	return app
}
