import { ApiService } from "."

// ---------------------------------------------------------------------------
// Types -- mirrors UserFileEntry from @openzosma/orchestrator
// ---------------------------------------------------------------------------

/** A single file or folder entry returned by the sandbox filesystem. */
export interface FileEntry {
	/** File or folder name. */
	name: string
	/** Relative path from the user-files root (e.g. "/docs/report.pdf"). */
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
	children?: FileEntry[]
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for the user files API.
 *
 * All file operations are path-based. Files live exclusively in the sandbox
 * filesystem and are proxied through the gateway.
 *
 * Calls the Next.js proxy routes at /api/files/* which forward to the gateway.
 */
export class FilesService {
	private apiService: ApiService

	constructor() {
		this.apiService = new ApiService()
	}

	/** Fetch the full recursive file tree for the current user. */
	async getTree(): Promise<FileEntry[]> {
		const { data } = await this.apiService.get<{ entries: FileEntry[] }>("/api/files/tree")
		return data?.entries ?? []
	}

	/** List files/folders under a specific directory path. */
	async listFiles(dirPath?: string): Promise<FileEntry[]> {
		const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""
		const { data } = await this.apiService.get<{ entries: FileEntry[] }>(`/api/files/list${qs}`)
		return data?.entries ?? []
	}

	/** Upload files via multipart form data to a target directory. */
	async uploadFiles(files: File[], dirPath?: string): Promise<FileEntry[]> {
		const formData = new FormData()
		for (const file of files) {
			formData.append("file", file)
		}

		const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""
		const { data } = await this.apiService.post<{ entries: FileEntry[] }>(`/api/files/upload${qs}`, formData)
		return data?.entries ?? []
	}

	/** Create a new folder at the given path. */
	async createFolder(path: string): Promise<FileEntry | null> {
		const { data } = await this.apiService.post<{ entry: FileEntry }>("/api/files/folder", { path })
		return data?.entry ?? null
	}

	/** Rename or move a file/folder from one path to another. */
	async renameFile(from: string, to: string): Promise<FileEntry | null> {
		const { data } = await this.apiService.post<{ entry: FileEntry }>("/api/files/rename", { from, to })
		return data?.entry ?? null
	}

	/** Delete a file or folder at the given path. */
	async deleteFile(path: string): Promise<void> {
		await this.apiService.delete(`/api/files?path=${encodeURIComponent(path)}`)
	}

	/** Get the download URL for a file by its path. */
	getDownloadUrl(path: string, forceDownload = false): string {
		const qs = new URLSearchParams({ path })
		if (forceDownload) qs.set("download", "true")
		return `/api/files/download?${qs.toString()}`
	}
}

const filesService = new FilesService()

export default filesService
