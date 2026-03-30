import { type Stats, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { dirname, extname, join, relative } from "node:path"

/**
 * Directories to exclude when scanning the workspace.
 */
const EXCLUDED_DIRS = new Set([".knowledge-base", ".git", "node_modules", "__pycache__", ".venv", "user-files"])

export interface FileSnapshot {
	/** Relative path from workspace root. */
	relativePath: string
	/** Last modification time in ms. */
	mtimeMs: number
	/** File size in bytes. */
	sizebytes: number
}

export interface DetectedFile {
	/** The filename (basename). */
	filename: string
	/** Relative path from workspace root. */
	relativePath: string
	/** Absolute path on disk. */
	absolutePath: string
	/** Size in bytes. */
	sizebytes: number
	/** MIME type derived from extension. */
	mediatype: string
}

export interface FileArtifactEvent {
	/** Filename for display. */
	filename: string
	/** MIME type. */
	mediatype: string
	/** Size in bytes. */
	sizebytes: number
	/** Base64-encoded file content (no longer populated; kept for type compatibility). */
	content?: string
}

/** Maps file extensions to MIME types. */
const MIME_MAP: Record<string, string> = {
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
}

const mimeFromExtension = (filepath: string): string => {
	const ext = extname(filepath).toLowerCase()
	return MIME_MAP[ext] ?? "application/octet-stream"
}

/**
 * Recursively walks a directory and returns file entries.
 * Skips excluded directories.
 */
const walkDir = (dir: string, baseDir: string): { relativePath: string; absolutePath: string; stat: Stats }[] => {
	const results: { relativePath: string; absolutePath: string; stat: Stats }[] = []

	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return results
	}

	for (const entry of entries) {
		const absolutePath = join(dir, entry)
		let stat: Stats
		try {
			stat = statSync(absolutePath) as Stats
		} catch {
			continue
		}

		if (stat.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry)) continue
			results.push(...walkDir(absolutePath, baseDir))
		} else if (stat.isFile()) {
			results.push({
				relativePath: relative(baseDir, absolutePath),
				absolutePath,
				stat,
			})
		}
	}

	return results
}

/**
 * Creates a snapshot of all files in a workspace directory.
 * All files (except those in excluded directories) are tracked.
 */
export const createSnapshot = (workspaceDir: string): Map<string, FileSnapshot> => {
	const snapshot = new Map<string, FileSnapshot>()

	for (const { relativePath, stat } of walkDir(workspaceDir, workspaceDir)) {
		snapshot.set(relativePath, {
			relativePath,
			mtimeMs: stat.mtimeMs,
			sizebytes: stat.size,
		})
	}

	return snapshot
}

/**
 * Compares the current state of a workspace against a previous snapshot.
 * Returns newly created or modified files that qualify as output.
 */
export const detectChanges = (
	workspaceDir: string,
	previousSnapshot: Map<string, FileSnapshot>,
): { newSnapshot: Map<string, FileSnapshot>; changedFiles: DetectedFile[] } => {
	const newSnapshot = createSnapshot(workspaceDir)
	const changedFiles: DetectedFile[] = []

	for (const [relPath, current] of newSnapshot) {
		const prev = previousSnapshot.get(relPath)
		if (!prev || prev.mtimeMs !== current.mtimeMs || prev.sizebytes !== current.sizebytes) {
			const absolutePath = join(workspaceDir, relPath)
			const filename = relPath.split("/").pop() ?? relPath
			changedFiles.push({
				filename,
				relativePath: relPath,
				absolutePath,
				sizebytes: current.sizebytes,
				mediatype: mimeFromExtension(relPath),
			})
		}
	}

	return { newSnapshot, changedFiles }
}

/**
 * Convert detected files into artifact event payloads (metadata only).
 *
 * Base64 content is intentionally omitted — the gateway strips it anyway
 * (artifacts are already accessible via the user-files API).
 */
export const buildArtifactEvents = (detectedFiles: DetectedFile[]): FileArtifactEvent[] => {
	return detectedFiles.map((file) => ({
		filename: file.filename,
		mediatype: file.mediatype,
		sizebytes: file.sizebytes,
	}))
}

const WORKSPACE_DIR = process.env.OPENZOSMA_WORKSPACE ?? "/workspace"
const USER_FILES_DIR = join(WORKSPACE_DIR, "user-files")

/**
 * Copy detected artifact files into /workspace/user-files/ai-generated/<folderName>/.
 *
 * Preserves the relative directory structure so cloned repos, nested project
 * outputs, etc. are browsable like a normal file manager.
 *
 * The EXCLUDED_DIRS set already contains "user-files", so copied files
 * won't be re-detected on subsequent scans.
 */
export const copyArtifactsToUserFiles = (folderName: string, detectedFiles: DetectedFile[]): void => {
	if (detectedFiles.length === 0) return

	const targetDir = join(USER_FILES_DIR, "ai-generated", folderName)
	mkdirSync(targetDir, { recursive: true })

	for (const file of detectedFiles) {
		const destPath = join(targetDir, file.relativePath)
		try {
			mkdirSync(dirname(destPath), { recursive: true })
			copyFileSync(file.absolutePath, destPath)
		} catch {
			// Skip files that can't be copied (e.g. already removed)
		}
	}
}
