import { FileIcon, FileJsonIcon, FileTextIcon, ImageIcon } from "lucide-react"
import type { ReactNode } from "react"

/**
 * Format a byte count as a human-readable size string.
 */
export const formatSizeBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Get an icon component for a given MIME type.
 */
export const getFileIcon = (mediatype: string): ReactNode => {
	if (mediatype.startsWith("image/")) return <ImageIcon className="size-4 text-blue-500" />
	if (mediatype === "application/json") return <FileJsonIcon className="size-4 text-yellow-500" />
	if (mediatype === "text/html") return <FileTextIcon className="size-4 text-orange-500" />
	if (mediatype.startsWith("text/")) return <FileTextIcon className="size-4 text-muted-foreground" />
	return <FileIcon className="size-4 text-muted-foreground" />
}

/**
 * Get a larger icon for the Files page grid/list view.
 */
export const getFileIconLarge = (mimeType: string | null, isFolder: boolean): ReactNode => {
	if (isFolder) return <FileIcon className="size-5 text-amber-500" />
	if (!mimeType) return <FileIcon className="size-5 text-muted-foreground" />
	if (mimeType.startsWith("image/")) return <ImageIcon className="size-5 text-blue-500" />
	if (mimeType === "application/json") return <FileJsonIcon className="size-5 text-yellow-500" />
	if (mimeType === "text/html") return <FileTextIcon className="size-5 text-orange-500" />
	if (mimeType.startsWith("text/")) return <FileTextIcon className="size-5 text-muted-foreground" />
	return <FileIcon className="size-5 text-muted-foreground" />
}

/**
 * Check if a MIME type can be previewed inline in the browser.
 */
export const isPreviewable = (mediatype: string): boolean => {
	return (
		mediatype.startsWith("image/") ||
		mediatype === "text/html" ||
		mediatype === "text/plain" ||
		mediatype === "text/markdown" ||
		mediatype === "text/csv" ||
		mediatype === "application/json"
	)
}

/**
 * Get a human-readable file type label from a MIME type.
 */
export const getFileTypeLabel = (mimeType: string | null, isFolder: boolean): string => {
	if (isFolder) return "Folder"
	if (!mimeType) return "File"
	if (mimeType.startsWith("image/")) return "Image"
	if (mimeType === "application/pdf") return "PDF"
	if (mimeType === "application/json") return "JSON"
	if (mimeType === "text/html") return "HTML"
	if (mimeType === "text/csv") return "Spreadsheet"
	if (mimeType === "text/plain") return "Text"
	if (mimeType === "text/markdown") return "Markdown"
	if (mimeType.startsWith("text/")) return "Text"
	if (mimeType.startsWith("video/")) return "Video"
	if (mimeType.startsWith("audio/")) return "Audio"
	return "File"
}
