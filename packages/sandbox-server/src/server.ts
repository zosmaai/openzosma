import {
	type Stats,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { basename, extname, join, normalize, relative, resolve } from "node:path"
import { createLogger } from "@openzosma/logger"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { SandboxAgentManager } from "./agent.js"
import type { CreateSessionRequest, KBFileEntry, SendMessageRequest, UserFileEntry } from "./types.js"

const log = createLogger({ component: "sandbox-server" })

/**
 * Create the Hono HTTP server that runs inside each sandbox container.
 *
 * This is the primary interface between the orchestrator and the sandboxed
 * pi-coding-agent. The orchestrator communicates with this server via HTTP,
 * routing messages in and streaming events (SSE) out.
 */
const WORKSPACE_DIR = process.env.OPENZOSMA_WORKSPACE ?? "/workspace"
const KB_DIR = join(WORKSPACE_DIR, ".knowledge-base")
const USER_FILES_DIR = join(WORKSPACE_DIR, "user-files")
const OUTPUT_DIR = "output"

/** Maps file extensions to MIME types for user files. */
const USER_FILE_MIME_MAP: Record<string, string> = {
	".html": "text/html",
	".pdf": "application/pdf",
	".csv": "text/csv",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".xml": "application/xml",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".wav": "audio/wav",
	".webp": "image/webp",
}

/**
 * Resolve a relative path within the user-files directory.
 * Returns null if the resolved path escapes the user-files root (path traversal).
 */
const resolveUserFilesPath = (relativePath: string): string | null => {
	const cleaned = relativePath.replace(/^\/+/, "")
	const resolved = resolve(USER_FILES_DIR, normalize(cleaned || "."))
	if (!resolved.startsWith(USER_FILES_DIR)) return null
	return resolved
}

/**
 * Get the MIME type for a file based on its extension.
 */
const mimeForFile = (filename: string): string => {
	const ext = extname(filename).toLowerCase()
	return USER_FILE_MIME_MAP[ext] ?? "application/octet-stream"
}

/**
 * Build a UserFileEntry from a filesystem path.
 */
const buildFileEntry = (absolutePath: string, stat: Stats): UserFileEntry => {
	const relPath = relative(USER_FILES_DIR, absolutePath)
	const name = basename(absolutePath)
	return {
		name,
		path: relPath,
		isFolder: stat.isDirectory(),
		mimeType: stat.isDirectory() ? null : mimeForFile(name),
		sizeBytes: stat.isDirectory() ? 0 : stat.size,
		modifiedAt: stat.mtime.toISOString(),
	}
}

/**
 * Recursively build a directory tree of UserFileEntry objects.
 */
const buildTree = (dir: string): UserFileEntry[] => {
	if (!existsSync(dir)) return []
	const entries: UserFileEntry[] = []

	let dirents: string[]
	try {
		dirents = readdirSync(dir)
	} catch {
		return entries
	}

	for (const name of dirents) {
		const fullPath = join(dir, name)
		let stat: Stats
		try {
			stat = statSync(fullPath)
		} catch {
			continue
		}

		const entry = buildFileEntry(fullPath, stat)
		if (stat.isDirectory()) {
			entry.children = buildTree(fullPath)
		}
		entries.push(entry)
	}

	return entries
}

/**
 * Resolve a relative path within the KB directory.
 * Returns null if the resolved path escapes the KB root (path traversal).
 */
const resolveKBPath = (relativePath: string): string | null => {
	const resolved = resolve(KB_DIR, normalize(relativePath))
	if (!resolved.startsWith(KB_DIR)) return null
	return resolved
}

/**
 * Recursively collect all files in a directory.
 * Returns entries with relative paths and file contents.
 */
const collectKBFiles = (dir: string, base: string = dir): KBFileEntry[] => {
	if (!existsSync(dir)) return []

	const entries: KBFileEntry[] = []
	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, dirent.name)
		if (dirent.isDirectory()) {
			entries.push(...collectKBFiles(fullPath, base))
		} else if (dirent.isFile()) {
			const relPath = relative(base, fullPath)
			try {
				const content = readFileSync(fullPath, "utf-8")
				const stat = statSync(fullPath)
				entries.push({
					path: relPath,
					content,
					sizeBytes: stat.size,
					modifiedAt: stat.mtime.toISOString(),
				})
			} catch {
				// Skip files that can't be read (e.g. broken symlinks)
			}
		}
	}
	return entries
}

export function createSandboxApp(): Hono {
	const app = new Hono()
	const agent = new SandboxAgentManager()

	// -----------------------------------------------------------------------
	// Health check
	// -----------------------------------------------------------------------

	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			sessions: agent.listSessions().length,
			uptime: process.uptime(),
		})
	})

	// -----------------------------------------------------------------------
	// Session management
	// -----------------------------------------------------------------------

	/**
	 * POST /sessions -- create a new agent session inside this sandbox.
	 */
	app.post("/sessions", async (c) => {
		const body = await c.req.json<CreateSessionRequest>().catch(() => ({}) as CreateSessionRequest)

		try {
			const sessionId = agent.createSession({
				sessionId: body.sessionId,
				provider: body.provider,
				model: body.model,
				systemPrompt: body.systemPrompt,
				toolsEnabled: body.toolsEnabled,
			})

			return c.json({ sessionId }, 201)
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Unknown error creating session"
			const stack = err instanceof Error ? err.stack : undefined
			log.error("POST /sessions failed", { error: message, stack })
			return c.json({ error: message }, 500)
		}
	})

	/**
	 * GET /sessions/:id -- check if a session exists.
	 */
	app.get("/sessions/:id", (c) => {
		const sessionId = c.req.param("id")
		if (!agent.hasSession(sessionId)) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json({ sessionId, status: "active" })
	})

	/**
	 * DELETE /sessions/:id -- end and remove a session.
	 */
	app.delete("/sessions/:id", (c) => {
		const sessionId = c.req.param("id")
		const deleted = agent.deleteSession(sessionId)
		if (!deleted) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json({ ok: true })
	})

	/**
	 * GET /sessions -- list all sessions in this sandbox.
	 */
	app.get("/sessions", (c) => {
		return c.json({ sessions: agent.listSessions() })
	})

	// -----------------------------------------------------------------------
	// Message handling (SSE streaming)
	// -----------------------------------------------------------------------

	/**
	 * POST /sessions/:id/messages -- send a user message and stream agent events.
	 *
	 * Returns an SSE stream. Each event is a JSON-encoded AgentStreamEvent.
	 * The stream ends when the agent finishes its turn.
	 */
	app.post("/sessions/:id/messages", (c) => {
		const sessionId = c.req.param("id")

		if (!agent.hasSession(sessionId)) {
			return c.json({ error: "Session not found" }, 404)
		}

		return streamSSE(c, async (stream) => {
			const abort = new AbortController()
			stream.onAbort(() => abort.abort())

			let body: SendMessageRequest
			try {
				body = await c.req.json<SendMessageRequest>()
			} catch {
				await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "Invalid request body" }) })
				return
			}

			if (!body.content) {
				await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "content is required" }) })
				return
			}

			try {
				for await (const event of agent.sendMessage(sessionId, body.content, abort.signal)) {
					await stream.writeSSE({
						event: event.type,
						data: JSON.stringify(event),
					})
				}
			} catch (err: unknown) {
				if (!abort.signal.aborted) {
					const message = err instanceof Error ? err.message : "Unknown error"
					await stream.writeSSE({
						event: "error",
						data: JSON.stringify({ type: "error", error: message }),
					})
				}
			}
		})
	})

	/**
	 * POST /sessions/:id/cancel -- cancel the current turn.
	 *
	 * This is a placeholder. The actual cancellation happens when the client
	 * disconnects from the SSE stream (abort signal fires).
	 */
	app.post("/sessions/:id/cancel", (c) => {
		const sessionId = c.req.param("id")
		if (!agent.hasSession(sessionId)) {
			return c.json({ error: "Session not found" }, 404)
		}
		// Cancellation is handled by the SSE abort signal in sendMessage.
		// A dedicated cancel mechanism would require tracking active generators,
		// which will be added if needed.
		return c.json({ ok: true })
	})

	// -----------------------------------------------------------------------
	// Knowledge base CRUD
	// -----------------------------------------------------------------------

	/**
	 * GET /kb -- list all KB files with content.
	 *
	 * Returns all files under /workspace/.knowledge-base/ recursively,
	 * including their content (for pull sync back to the dashboard).
	 */
	app.get("/kb", (c) => {
		const files = collectKBFiles(KB_DIR)
		return c.json({ files })
	})

	/**
	 * PUT /kb/* -- create or update a KB file.
	 *
	 * The path after /kb/ is the relative file path within the KB directory.
	 * Body: { content: string }
	 */
	app.put("/kb/*", async (c) => {
		const filePath = c.req.path.replace(/^\/kb\//, "")
		if (!filePath) {
			return c.json({ error: "File path is required" }, 400)
		}

		const resolved = resolveKBPath(filePath)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		let body: { content: string }
		try {
			body = await c.req.json<{ content: string }>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (typeof body.content !== "string") {
			return c.json({ error: "content must be a string" }, 400)
		}

		// Ensure parent directories exist
		const parentDir = resolve(resolved, "..")
		mkdirSync(parentDir, { recursive: true })

		writeFileSync(resolved, body.content, "utf-8")
		return c.json({ ok: true, path: filePath })
	})

	/**
	 * DELETE /kb/* -- delete a KB file or directory.
	 *
	 * The path after /kb/ is the relative file path within the KB directory.
	 */
	app.delete("/kb/*", (c) => {
		const filePath = c.req.path.replace(/^\/kb\//, "")
		if (!filePath) {
			return c.json({ error: "File path is required" }, 400)
		}

		const resolved = resolveKBPath(filePath)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		if (!existsSync(resolved)) {
			return c.json({ error: "File not found" }, 404)
		}

		rmSync(resolved, { recursive: true, force: true })
		return c.json({ ok: true, path: filePath })
	})

	// -----------------------------------------------------------------------
	// File upload (for chat attachments)
	// -----------------------------------------------------------------------

	/**
	 * POST /upload -- write files into the workspace.
	 *
	 * Accepts a JSON body with an array of files, each containing a filename,
	 * base64-encoded content, and target directory. Files are written to the
	 * workspace so the agent can access them during tool execution.
	 *
	 * Body: { files: Array<{ filename: string; content: string; dir?: string }> }
	 * - content: base64-encoded file data
	 * - dir: subdirectory within /workspace/ (default: "user-uploads")
	 */
	app.post("/upload", async (c) => {
		let body: { files: Array<{ filename: string; content: string; dir?: string }> }
		try {
			body = await c.req.json<typeof body>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (!Array.isArray(body.files) || body.files.length === 0) {
			return c.json({ error: "files array is required and must not be empty" }, 400)
		}

		const results: Array<{ filename: string; path: string }> = []

		for (const file of body.files) {
			if (!file.filename || !file.content) {
				continue
			}

			const dir = file.dir || "user-uploads"
			// Sanitize to prevent path traversal
			const safeName = file.filename.replace(/[/\\]/g, "_")
			const safeDir = dir.replace(/\.\./g, "").replace(/^\/+/, "")
			const targetDir = join(WORKSPACE_DIR, safeDir)
			mkdirSync(targetDir, { recursive: true })

			const targetPath = join(targetDir, safeName)
			// Verify resolved path stays within workspace
			const resolved = resolve(targetPath)
			if (!resolved.startsWith(resolve(WORKSPACE_DIR))) {
				log.warn("Upload path traversal attempt", { filename: file.filename, dir })
				continue
			}

			try {
				const buffer = Buffer.from(file.content, "base64")
				writeFileSync(targetPath, buffer)
				results.push({
					filename: safeName,
					path: `${safeDir}/${safeName}`,
				})
			} catch (err) {
				log.warn(`Failed to write uploaded file ${safeName}`, {
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		return c.json({ ok: true, uploaded: results })
	})

	// -----------------------------------------------------------------------
	// User files management
	// -----------------------------------------------------------------------

	/**
	 * GET /user-files/tree -- recursive directory tree of all user files.
	 *
	 * Returns a nested structure with children[] on folder entries.
	 */
	app.get("/user-files/tree", (c) => {
		mkdirSync(USER_FILES_DIR, { recursive: true })
		const tree = buildTree(USER_FILES_DIR)
		return c.json({ entries: tree })
	})

	/**
	 * GET /user-files/list -- list contents of a single directory.
	 *
	 * Query params:
	 *   path: relative directory path (default: "/")
	 */
	app.get("/user-files/list", (c) => {
		const dirPath = c.req.query("path") || "/"
		const resolved = resolveUserFilesPath(dirPath)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		mkdirSync(USER_FILES_DIR, { recursive: true })

		if (!existsSync(resolved)) {
			return c.json({ entries: [] })
		}

		let stat: Stats
		try {
			stat = statSync(resolved)
		} catch {
			return c.json({ entries: [] })
		}

		if (!stat.isDirectory()) {
			return c.json({ error: "Path is not a directory" }, 400)
		}

		const entries: UserFileEntry[] = []
		let dirents: string[]
		try {
			dirents = readdirSync(resolved)
		} catch {
			return c.json({ entries: [] })
		}

		for (const name of dirents) {
			const fullPath = join(resolved, name)
			let entryStat: Stats
			try {
				entryStat = statSync(fullPath)
			} catch {
				continue
			}
			entries.push(buildFileEntry(fullPath, entryStat))
		}

		return c.json({ entries })
	})

	/**
	 * GET /user-files/download -- stream a file's content.
	 *
	 * Query params:
	 *   path: relative file path within user-files
	 */
	app.get("/user-files/download", (c) => {
		const filePath = c.req.query("path")
		if (!filePath) {
			return c.json({ error: "path query parameter is required" }, 400)
		}

		const resolved = resolveUserFilesPath(filePath)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		if (!existsSync(resolved)) {
			return c.json({ error: "File not found" }, 404)
		}

		let stat: Stats
		try {
			stat = statSync(resolved)
		} catch {
			return c.json({ error: "Cannot read file" }, 500)
		}

		if (!stat.isFile()) {
			return c.json({ error: "Path is not a file" }, 400)
		}

		const filename = basename(resolved)
		const mime = mimeForFile(filename)

		try {
			const data = readFileSync(resolved)
			c.header("Content-Type", mime)
			c.header("Content-Length", String(stat.size))
			c.header("Content-Disposition", `inline; filename="${filename}"`)
			return c.body(data)
		} catch {
			return c.json({ error: "Failed to read file" }, 500)
		}
	})

	/**
	 * POST /user-files/upload -- upload files to a directory.
	 *
	 * Query params:
	 *   path: target directory path (default: "/")
	 *
	 * Body: { files: Array<{ filename: string; content: string }> }
	 * - content: base64-encoded file data
	 */
	app.post("/user-files/upload", async (c) => {
		const dirPath = c.req.query("path") || "/"
		const resolved = resolveUserFilesPath(dirPath)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		let body: { files: Array<{ filename: string; content: string }> }
		try {
			body = await c.req.json<typeof body>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (!Array.isArray(body.files) || body.files.length === 0) {
			return c.json({ error: "files array is required and must not be empty" }, 400)
		}

		mkdirSync(resolved, { recursive: true })

		const uploaded: UserFileEntry[] = []

		for (const file of body.files) {
			if (!file.filename || !file.content) continue

			// Sanitize filename: strip path separators
			const safeName = basename(file.filename).replace(/[/\\]/g, "_")
			if (!safeName) continue

			const targetPath = join(resolved, safeName)
			// Verify resolved path stays within user-files
			const targetResolved = resolve(targetPath)
			if (!targetResolved.startsWith(resolve(USER_FILES_DIR))) {
				log.warn("User files upload path traversal attempt", { filename: file.filename })
				continue
			}

			try {
				const buffer = Buffer.from(file.content, "base64")
				writeFileSync(targetPath, buffer)
				const stat = statSync(targetPath)
				uploaded.push(buildFileEntry(targetPath, stat))
			} catch (err) {
				log.warn(`Failed to write user file ${safeName}`, {
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		return c.json({ ok: true, uploaded })
	})

	/**
	 * POST /user-files/folder -- create a new directory.
	 *
	 * Body: { path: string }
	 */
	app.post("/user-files/folder", async (c) => {
		let body: { path: string }
		try {
			body = await c.req.json<typeof body>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (!body.path) {
			return c.json({ error: "path is required" }, 400)
		}

		const resolved = resolveUserFilesPath(body.path)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		if (existsSync(resolved)) {
			return c.json({ error: "Path already exists" }, 409)
		}

		try {
			mkdirSync(resolved, { recursive: true })
			const stat = statSync(resolved)
			const entry = buildFileEntry(resolved, stat)
			return c.json({ ok: true, entry }, 201)
		} catch (err) {
			log.error("Failed to create folder", {
				path: body.path,
				error: err instanceof Error ? err.message : String(err),
			})
			return c.json({ error: "Failed to create folder" }, 500)
		}
	})

	/**
	 * POST /user-files/rename -- rename or move a file/folder.
	 *
	 * Body: { from: string; to: string }
	 */
	app.post("/user-files/rename", async (c) => {
		let body: { from: string; to: string }
		try {
			body = await c.req.json<typeof body>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (!body.from || !body.to) {
			return c.json({ error: "from and to are required" }, 400)
		}

		const resolvedFrom = resolveUserFilesPath(body.from)
		const resolvedTo = resolveUserFilesPath(body.to)
		if (!resolvedFrom || !resolvedTo) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		if (!existsSync(resolvedFrom)) {
			return c.json({ error: "Source path not found" }, 404)
		}

		if (existsSync(resolvedTo)) {
			return c.json({ error: "Destination already exists" }, 409)
		}

		try {
			// Ensure parent directory of destination exists
			const parentDir = resolve(resolvedTo, "..")
			mkdirSync(parentDir, { recursive: true })

			renameSync(resolvedFrom, resolvedTo)

			const stat = statSync(resolvedTo)
			const entry = buildFileEntry(resolvedTo, stat)
			return c.json({ ok: true, entry })
		} catch (err) {
			log.error("Failed to rename", {
				from: body.from,
				to: body.to,
				error: err instanceof Error ? err.message : String(err),
			})
			return c.json({ error: "Failed to rename" }, 500)
		}
	})

	/**
	 * DELETE /user-files -- delete a file or folder.
	 *
	 * Query params:
	 *   path: relative path to delete
	 */
	app.delete("/user-files", (c) => {
		const filePath = c.req.query("path")
		if (!filePath) {
			return c.json({ error: "path query parameter is required" }, 400)
		}

		const resolved = resolveUserFilesPath(filePath)
		if (!resolved) {
			return c.json({ error: "Invalid path (traversal detected)" }, 400)
		}

		// Prevent deleting the root user-files directory itself
		if (resolved === resolve(USER_FILES_DIR)) {
			return c.json({ error: "Cannot delete the root user-files directory" }, 400)
		}

		if (!existsSync(resolved)) {
			return c.json({ error: "Path not found" }, 404)
		}

		try {
			rmSync(resolved, { recursive: true, force: true })
			return c.json({ ok: true })
		} catch (err) {
			log.error("Failed to delete", {
				path: filePath,
				error: err instanceof Error ? err.message : String(err),
			})
			return c.json({ error: "Failed to delete" }, 500)
		}
	})

	// -----------------------------------------------------------------------
	// Artifact file download (for files too large for base64 in SSE events)
	// -----------------------------------------------------------------------

	/**
	 * GET /artifacts/:filename -- download an output file from the workspace.
	 *
	 * Scans the workspace for matching output files. Returns the file content
	 * with appropriate Content-Type and Content-Disposition headers.
	 */
	app.get("/artifacts/:filename", (c) => {
		const filename = c.req.param("filename")
		const sanitized = filename.replace(/[/\\]/g, "")
		if (!sanitized) {
			return c.json({ error: "Invalid filename" }, 400)
		}

		// Search for the file in the workspace
		const candidates = [join(WORKSPACE_DIR, sanitized), join(WORKSPACE_DIR, OUTPUT_DIR, sanitized)]

		for (const filepath of candidates) {
			if (existsSync(filepath)) {
				try {
					const stat = statSync(filepath)
					if (!stat.isFile()) continue

					const ext = sanitized.split(".").pop()?.toLowerCase() ?? ""
					const mimeMap: Record<string, string> = {
						html: "text/html",
						pdf: "application/pdf",
						csv: "text/csv",
						png: "image/png",
						jpg: "image/jpeg",
						jpeg: "image/jpeg",
						gif: "image/gif",
						svg: "image/svg+xml",
						txt: "text/plain",
						md: "text/markdown",
						json: "application/json",
						xml: "application/xml",
					}
					const contentType = mimeMap[ext] ?? "application/octet-stream"
					const data = readFileSync(filepath)

					c.header("Content-Type", contentType)
					c.header("Content-Length", String(stat.size))
					c.header("Content-Disposition", `inline; filename="${sanitized}"`)
					return c.body(data)
				} catch {
					// skip unreadable files
				}
			}
		}

		return c.json({ error: "Artifact not found" }, 404)
	})

	return app
}
