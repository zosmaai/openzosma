import type { Role } from "@openzosma/auth"
import { createLogger } from "@openzosma/logger"
import type { OrchestratorSessionManager } from "@openzosma/orchestrator"
import { Hono } from "hono"
import { requirePermission } from "./middleware/auth.js"

const log = createLogger({ component: "file-routes" })

/** Maximum upload size: 50 MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024

interface FileRouteDeps {
	orchestrator: OrchestratorSessionManager
}

/** Context variables available on all file routes (set by auth middleware). */
interface FileRouteVariables {
	userId: string
	userRole: Role
	apiKeyId: string
	apiKeyScopes: string[]
}

/**
 * Create the Hono sub-router for file management routes.
 *
 * All routes are mounted under /api/v1/files by the main app.
 * Each route is a thin proxy to the sandbox filesystem via the orchestrator.
 * The sandbox is created eagerly on first file operation if it doesn't exist.
 */
export const createFileRoutes = ({ orchestrator }: FileRouteDeps) => {
	const app = new Hono<{ Variables: FileRouteVariables }>()

	// -------------------------------------------------------------------
	// GET /tree -- recursive directory tree
	// -------------------------------------------------------------------
	app.get("/tree", requirePermission("files", "read"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		try {
			const entries = await orchestrator.getUserFilesTree(userId)
			return c.json({ entries })
		} catch (err) {
			log.error("Failed to get file tree", { error: err instanceof Error ? err.message : String(err) })
			return c.json({ error: "Failed to retrieve file tree" }, 500)
		}
	})

	// -------------------------------------------------------------------
	// GET /list -- list contents of a single directory
	// Query: path (default: "/")
	// -------------------------------------------------------------------
	app.get("/list", requirePermission("files", "read"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		const path = c.req.query("path") || "/"

		try {
			const entries = await orchestrator.listUserFiles(userId, path)
			return c.json({ entries })
		} catch (err) {
			log.error("Failed to list files", { error: err instanceof Error ? err.message : String(err) })
			return c.json({ error: "Failed to list files" }, 500)
		}
	})

	// -------------------------------------------------------------------
	// GET /download -- download a file
	// Query: path (required)
	// -------------------------------------------------------------------
	app.get("/download", requirePermission("files", "read"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		const path = c.req.query("path")
		if (!path) return c.json({ error: "path query parameter is required" }, 400)

		try {
			const response = await orchestrator.downloadUserFile(userId, path)

			// Forward headers from the sandbox response
			const contentType = response.headers.get("Content-Type")
			const contentLength = response.headers.get("Content-Length")
			const contentDisposition = response.headers.get("Content-Disposition")

			if (contentType) c.header("Content-Type", contentType)
			if (contentLength) c.header("Content-Length", contentLength)
			if (contentDisposition) c.header("Content-Disposition", contentDisposition)
			c.header("Cache-Control", "private, max-age=3600")

			const body = response.body
			if (!body) return c.json({ error: "No file content" }, 500)

			return c.body(body as ReadableStream)
		} catch (err) {
			log.error("File download failed", { error: err instanceof Error ? err.message : String(err) })
			return c.json({ error: "File download failed" }, 500)
		}
	})

	// -------------------------------------------------------------------
	// POST /upload -- upload files (multipart/form-data)
	// Query: path (target directory, default: "/")
	// -------------------------------------------------------------------
	app.post("/upload", requirePermission("files", "write"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		const dirPath = c.req.query("path") || "/"

		const body = await c.req.parseBody({ all: true })
		const fileEntries = body.file
		if (!fileEntries) {
			return c.json({ error: "No files provided. Use 'file' field name." }, 400)
		}

		const rawFiles = Array.isArray(fileEntries) ? fileEntries : [fileEntries]
		const filesToUpload: Array<{ filename: string; content: string }> = []

		for (const f of rawFiles) {
			if (!(f instanceof File)) continue

			if (f.size > MAX_FILE_SIZE) {
				return c.json({ error: `File "${f.name}" exceeds maximum size of 50 MB` }, 400)
			}

			const buffer = Buffer.from(await f.arrayBuffer())
			filesToUpload.push({
				filename: f.name,
				content: buffer.toString("base64"),
			})
		}

		if (filesToUpload.length === 0) {
			return c.json({ error: "No valid files to upload" }, 400)
		}

		try {
			const uploaded = await orchestrator.uploadUserFiles(userId, dirPath, filesToUpload)
			return c.json({ entries: uploaded }, 201)
		} catch (err) {
			log.error("File upload failed", { error: err instanceof Error ? err.message : String(err) })
			return c.json({ error: "File upload failed" }, 500)
		}
	})

	// -------------------------------------------------------------------
	// POST /folder -- create a folder
	// Body: { path: string }
	// -------------------------------------------------------------------
	app.post("/folder", requirePermission("files", "write"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		let reqBody: { path: string }
		try {
			reqBody = await c.req.json<{ path: string }>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (!reqBody.path || !reqBody.path.trim()) {
			return c.json({ error: "path is required" }, 400)
		}

		try {
			const entry = await orchestrator.createUserFolder(userId, reqBody.path.trim())
			return c.json({ entry }, 201)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.error("Create folder failed", { error: message })
			if (message.includes("409")) {
				return c.json({ error: "A folder with this name already exists" }, 409)
			}
			return c.json({ error: "Failed to create folder" }, 500)
		}
	})

	// -------------------------------------------------------------------
	// POST /rename -- rename or move a file/folder
	// Body: { from: string; to: string }
	// -------------------------------------------------------------------
	app.post("/rename", requirePermission("files", "write"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		let reqBody: { from: string; to: string }
		try {
			reqBody = await c.req.json<{ from: string; to: string }>()
		} catch {
			return c.json({ error: "Invalid request body" }, 400)
		}

		if (!reqBody.from || !reqBody.to) {
			return c.json({ error: "from and to are required" }, 400)
		}

		try {
			const entry = await orchestrator.renameUserFile(userId, reqBody.from, reqBody.to)
			return c.json({ entry })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.error("Rename failed", { error: message })
			if (message.includes("404")) {
				return c.json({ error: "Source path not found" }, 404)
			}
			if (message.includes("409")) {
				return c.json({ error: "Destination already exists" }, 409)
			}
			return c.json({ error: "Rename failed" }, 500)
		}
	})

	// -------------------------------------------------------------------
	// DELETE / -- delete a file or folder
	// Query: path (required)
	// -------------------------------------------------------------------
	app.delete("/", requirePermission("files", "delete"), async (c) => {
		const userId = c.get("userId") as string | undefined
		if (!userId) return c.json({ error: "userId required" }, 400)

		const path = c.req.query("path")
		if (!path) return c.json({ error: "path query parameter is required" }, 400)

		try {
			await orchestrator.deleteUserFile(userId, path)
			return c.json({ ok: true })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.error("Delete failed", { error: message })
			if (message.includes("404")) {
				return c.json({ error: "Path not found" }, 404)
			}
			return c.json({ error: "Delete failed" }, 500)
		}
	})

	return app
}
