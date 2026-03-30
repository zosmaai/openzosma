import type { AgentStreamEvent } from "@openzosma/agents"
import { createLogger } from "@openzosma/logger"
import type {
	KBFileEntry,
	KBListResponse,
	SandboxCreateSessionRequest,
	SandboxCreateSessionResponse,
	SandboxHealthResponse,
	SandboxSessionInfo,
	SandboxSessionListResponse,
	UserFileEntry,
	UserFilesListResponse,
} from "./types.js"

const log = createLogger({ component: "orchestrator" })

/** Default request timeout (30s). */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * HTTP client for communicating with the sandbox-server running inside
 * an OpenShell sandbox. Uses native fetch().
 *
 * Initially the orchestrator reaches the sandbox via `openshell exec curl`,
 * but once we have pod IP connectivity this client calls the sandbox
 * directly over HTTP.
 */
export class SandboxHttpClient {
	private readonly baseUrl: string
	private readonly timeoutMs: number

	constructor(host: string, port: number, opts?: { timeoutMs?: number }) {
		this.baseUrl = `http://${host}:${port}`
		this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	// -----------------------------------------------------------------------
	// Health
	// -----------------------------------------------------------------------

	async health(): Promise<SandboxHealthResponse> {
		const res = await this.fetch("/health")
		return res.json() as Promise<SandboxHealthResponse>
	}

	async isHealthy(): Promise<boolean> {
		try {
			const h = await this.health()
			return h.status === "ok"
		} catch {
			return false
		}
	}

	// -----------------------------------------------------------------------
	// Sessions
	// -----------------------------------------------------------------------

	async createSession(req: SandboxCreateSessionRequest): Promise<SandboxCreateSessionResponse> {
		const res = await this.fetch("/sessions", {
			method: "POST",
			body: JSON.stringify(req),
		})
		if (!res.ok) {
			let detail: string
			try {
				const body = (await res.json()) as { error?: string }
				detail = body.error ?? `HTTP ${res.status}`
			} catch {
				detail = await res.text().catch(() => `HTTP ${res.status}`)
			}
			throw new Error(`Sandbox createSession failed (${res.status}): ${detail}`)
		}
		return res.json() as Promise<SandboxCreateSessionResponse>
	}

	async getSession(sessionId: string): Promise<SandboxSessionInfo | null> {
		try {
			const res = await this.fetch(`/sessions/${sessionId}`)
			if (res.status === 404) return null
			return res.json() as Promise<SandboxSessionInfo>
		} catch {
			return null
		}
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		try {
			const res = await this.fetch(`/sessions/${sessionId}`, { method: "DELETE" })
			return res.ok
		} catch {
			return false
		}
	}

	async listSessions(): Promise<string[]> {
		const res = await this.fetch("/sessions")
		const body = (await res.json()) as SandboxSessionListResponse
		return body.sessions
	}

	// -----------------------------------------------------------------------
	// Message streaming (SSE)
	// -----------------------------------------------------------------------

	/**
	 * Send a message to a session and stream back agent events via SSE.
	 *
	 * The sandbox-server returns a standard SSE stream where each event
	 * is a JSON-encoded AgentStreamEvent.
	 */
	async *sendMessage(sessionId: string, content: string, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
		const res = await this.fetch(`/sessions/${sessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({ content }),
			signal,
			// Don't use the default timeout for streaming responses
			timeout: 0,
		})

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`Sandbox message request failed (${res.status}): ${text}`)
		}

		const body = res.body
		if (!body) {
			throw new Error("No response body from sandbox-server")
		}

		yield* this.parseSSE(body, signal)
	}

	async cancelSession(sessionId: string): Promise<boolean> {
		try {
			const res = await this.fetch(`/sessions/${sessionId}/cancel`, { method: "POST" })
			return res.ok
		} catch {
			return false
		}
	}

	// -----------------------------------------------------------------------
	// File upload
	// -----------------------------------------------------------------------

	/**
	 * Upload files into the sandbox workspace.
	 *
	 * Each file is base64-encoded and written to the specified subdirectory
	 * within /workspace/ inside the sandbox.
	 *
	 * @returns Array of successfully uploaded file paths.
	 */
	async uploadFiles(
		files: Array<{ filename: string; content: string; dir?: string }>,
	): Promise<Array<{ filename: string; path: string }>> {
		const res = await this.fetch("/upload", {
			method: "POST",
			body: JSON.stringify({ files }),
		})

		if (!res.ok) {
			const text = await res.text().catch(() => `HTTP ${res.status}`)
			throw new Error(`Sandbox file upload failed (${res.status}): ${text}`)
		}

		const body = (await res.json()) as { ok: boolean; uploaded: Array<{ filename: string; path: string }> }
		return body.uploaded
	}

	// -----------------------------------------------------------------------
	// Knowledge base
	// -----------------------------------------------------------------------

	/**
	 * List all files in the sandbox's knowledge base, including content.
	 */
	async listKBFiles(): Promise<KBFileEntry[]> {
		const res = await this.fetch("/kb")
		if (!res.ok) {
			throw new Error(`Sandbox listKBFiles failed (${res.status})`)
		}
		const body = (await res.json()) as KBListResponse
		return body.files
	}

	/**
	 * Write or update a file in the sandbox's knowledge base.
	 */
	async writeKBFile(path: string, content: string): Promise<void> {
		const res = await this.fetch(`/kb/${path}`, {
			method: "PUT",
			body: JSON.stringify({ content }),
		})
		if (!res.ok) {
			let detail: string
			try {
				const body = (await res.json()) as { error?: string }
				detail = body.error ?? `HTTP ${res.status}`
			} catch {
				detail = await res.text().catch(() => `HTTP ${res.status}`)
			}
			throw new Error(`Sandbox writeKBFile failed (${res.status}): ${detail}`)
		}
	}

	/**
	 * Delete a file from the sandbox's knowledge base.
	 */
	async deleteKBFile(path: string): Promise<void> {
		const res = await this.fetch(`/kb/${path}`, { method: "DELETE" })
		if (!res.ok && res.status !== 404) {
			throw new Error(`Sandbox deleteKBFile failed (${res.status})`)
		}
	}

	// -----------------------------------------------------------------------
	// User files
	// -----------------------------------------------------------------------

	/**
	 * Get the recursive directory tree of all user files.
	 */
	async getUserFilesTree(): Promise<UserFileEntry[]> {
		const res = await this.fetch("/user-files/tree")
		if (!res.ok) {
			throw new Error(`Sandbox getUserFilesTree failed (${res.status})`)
		}
		const body = (await res.json()) as UserFilesListResponse
		return body.entries
	}

	/**
	 * List contents of a single directory within user-files.
	 */
	async listUserFiles(path = "/"): Promise<UserFileEntry[]> {
		const res = await this.fetch(`/user-files/list?path=${encodeURIComponent(path)}`)
		if (!res.ok) {
			throw new Error(`Sandbox listUserFiles failed (${res.status})`)
		}
		const body = (await res.json()) as UserFilesListResponse
		return body.entries
	}

	/**
	 * Download a file from user-files. Returns the raw Response
	 * so the caller can stream the body.
	 */
	async downloadUserFile(path: string): Promise<Response> {
		const res = await this.fetch(`/user-files/download?path=${encodeURIComponent(path)}`)
		if (!res.ok) {
			const text = await res.text().catch(() => `HTTP ${res.status}`)
			throw new Error(`Sandbox downloadUserFile failed (${res.status}): ${text}`)
		}
		return res
	}

	/**
	 * Upload files to a directory within user-files.
	 */
	async uploadUserFiles(
		dirPath: string,
		files: Array<{ filename: string; content: string }>,
	): Promise<UserFileEntry[]> {
		const res = await this.fetch(`/user-files/upload?path=${encodeURIComponent(dirPath)}`, {
			method: "POST",
			body: JSON.stringify({ files }),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => `HTTP ${res.status}`)
			throw new Error(`Sandbox uploadUserFiles failed (${res.status}): ${text}`)
		}
		const body = (await res.json()) as { ok: boolean; uploaded: UserFileEntry[] }
		return body.uploaded
	}

	/**
	 * Create a folder within user-files.
	 */
	async createUserFolder(path: string): Promise<UserFileEntry> {
		const res = await this.fetch("/user-files/folder", {
			method: "POST",
			body: JSON.stringify({ path }),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => `HTTP ${res.status}`)
			throw new Error(`Sandbox createUserFolder failed (${res.status}): ${text}`)
		}
		const body = (await res.json()) as { ok: boolean; entry: UserFileEntry }
		return body.entry
	}

	/**
	 * Rename or move a file/folder within user-files.
	 */
	async renameUserFile(from: string, to: string): Promise<UserFileEntry> {
		const res = await this.fetch("/user-files/rename", {
			method: "POST",
			body: JSON.stringify({ from, to }),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => `HTTP ${res.status}`)
			throw new Error(`Sandbox renameUserFile failed (${res.status}): ${text}`)
		}
		const body = (await res.json()) as { ok: boolean; entry: UserFileEntry }
		return body.entry
	}

	/**
	 * Delete a file or folder within user-files.
	 */
	async deleteUserFile(path: string): Promise<void> {
		const res = await this.fetch(`/user-files?path=${encodeURIComponent(path)}`, {
			method: "DELETE",
		})
		if (!res.ok && res.status !== 404) {
			const text = await res.text().catch(() => `HTTP ${res.status}`)
			throw new Error(`Sandbox deleteUserFile failed (${res.status}): ${text}`)
		}
	}

	// -----------------------------------------------------------------------
	// SSE parser
	// -----------------------------------------------------------------------

	private async *parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let currentData = ""
		let chunkCount = 0

		try {
			while (true) {
				if (signal?.aborted) break

				const { done, value } = await reader.read()
				if (done) {
					break
				}

				chunkCount++
				const raw = decoder.decode(value, { stream: true })
				buffer += raw
				const lines = buffer.split("\n")

				// Keep the last incomplete line in the buffer
				buffer = lines.pop() ?? ""

				for (const line of lines) {
					if (line.startsWith("data:")) {
						currentData += line.slice(5).trimStart()
					} else if (line.trim() === "" && currentData) {
						// Empty line = end of event
						try {
							const event = JSON.parse(currentData) as AgentStreamEvent
							yield event
						} catch (e) {
							log.error("parseSSE error", { error: e instanceof Error ? e.message : String(e) })
						}
						currentData = ""
					}
				}
			}

			// Flush any remaining data left in the buffer after stream ends.
			// The last SSE event (typically turn_end) may not have a trailing
			// blank line before the connection closes.
			if (buffer.startsWith("data:")) {
				currentData += buffer.slice(5).trimStart()
			}
			if (currentData) {
				try {
					const event = JSON.parse(currentData) as AgentStreamEvent
					yield event
				} catch (e) {
					log.error("parseSSE flush error", { error: e instanceof Error ? e.message : String(e) })
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	// -----------------------------------------------------------------------
	// Internal fetch wrapper
	// -----------------------------------------------------------------------

	private async fetch(
		path: string,
		opts?: { method?: string; body?: string; signal?: AbortSignal; timeout?: number },
	): Promise<Response> {
		const url = this.baseUrl + path
		const timeout = opts?.timeout ?? this.timeoutMs

		let signal = opts?.signal
		let timeoutId: ReturnType<typeof setTimeout> | undefined

		// Create a timeout signal if no external signal and timeout > 0
		if (!signal && timeout > 0) {
			const controller = new AbortController()
			signal = controller.signal
			timeoutId = setTimeout(() => controller.abort(), timeout)
		}

		try {
			const res = await fetch(url, {
				method: opts?.method ?? "GET",
				headers: opts?.body ? { "Content-Type": "application/json" } : undefined,
				body: opts?.body,
				signal,
			})
			return res
		} finally {
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId)
			}
		}
	}
}
