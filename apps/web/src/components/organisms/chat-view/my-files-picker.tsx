"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"

// UI
import { Button } from "@/src/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/src/components/ui/dialog"
import { ScrollArea } from "@/src/components/ui/scroll-area"

// Hooks & Services
import { useFileList } from "@/src/hooks/use-files"
import type { FileEntry } from "@/src/services/files.services"
import filesService from "@/src/services/files.services"

// Utils
import { formatSizeBytes, getFileIconLarge } from "@/src/utils/file-utils"

// Icons
import { IconChevronLeft, IconFolder } from "@tabler/icons-react"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MyFilesPickerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Called with the selected File objects once the user confirms selection. */
	onFilesSelected: (files: File[]) => void
}

// ---------------------------------------------------------------------------
// MyFilesPicker
// ---------------------------------------------------------------------------

/**
 * A dialog that lets users browse their uploaded files and select one or more
 * to attach to a chat message. Uses path-based navigation.
 */
const MyFilesPicker = ({ open, onOpenChange, onFilesSelected }: MyFilesPickerProps) => {
	const [currentDirPath, setCurrentDirPath] = useState<string>("/")
	const [folderStack, setFolderStack] = useState<{ path: string; name: string }[]>([])
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
	const [loading, setLoading] = useState(false)

	const { data: files, isLoading: filesLoading } = useFileList(currentDirPath)

	const navigateInto = useCallback((folder: FileEntry) => {
		setFolderStack((prev) => [...prev, { path: folder.path, name: folder.name }])
		setCurrentDirPath(folder.path)
	}, [])

	const navigateBack = useCallback(() => {
		setFolderStack((prev) => {
			const next = prev.slice(0, -1)
			setCurrentDirPath(next.length > 0 ? next[next.length - 1].path : "/")
			return next
		})
	}, [])

	const toggleSelection = useCallback((file: FileEntry) => {
		if (file.isFolder) return
		setSelectedPaths((prev) => {
			const next = new Set(prev)
			if (next.has(file.path)) {
				next.delete(file.path)
			} else {
				next.add(file.path)
			}
			return next
		})
	}, [])

	const handleConfirm = useCallback(async () => {
		if (selectedPaths.size === 0) return

		setLoading(true)
		try {
			const selectedFiles = (files ?? []).filter((f) => selectedPaths.has(f.path) && !f.isFolder)
			const fileObjects: File[] = []

			for (const sf of selectedFiles) {
				const url = filesService.getDownloadUrl(sf.path)
				const response = await fetch(url)
				if (!response.ok) {
					toast.error(`Failed to load "${sf.name}"`)
					continue
				}
				const blob = await response.blob()
				const file = new File([blob], sf.name, {
					type: sf.mimeType ?? "application/octet-stream",
				})
				fileObjects.push(file)
			}

			if (fileObjects.length > 0) {
				onFilesSelected(fileObjects)
			}

			// Reset state
			setSelectedPaths(new Set())
			setCurrentDirPath("/")
			setFolderStack([])
			onOpenChange(false)
		} catch {
			toast.error("Failed to attach files")
		} finally {
			setLoading(false)
		}
	}, [selectedPaths, files, onFilesSelected, onOpenChange])

	const handleClose = useCallback(() => {
		setSelectedPaths(new Set())
		setCurrentDirPath("/")
		setFolderStack([])
		onOpenChange(false)
	}, [onOpenChange])

	const sorted = [...(files ?? [])].sort((a, b) => {
		if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
		return a.name.localeCompare(b.name)
	})

	const currentFolderName = folderStack.length > 0 ? folderStack[folderStack.length - 1].name : "My Files"

	return (
		<Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Attach from My Files</DialogTitle>
					<DialogDescription>Select files to attach to your message.</DialogDescription>
				</DialogHeader>

				{/* Navigation */}
				<div className="flex items-center gap-2 text-sm">
					{folderStack.length > 0 && (
						<Button variant="ghost" size="sm" onClick={navigateBack} className="h-7 px-2">
							<IconChevronLeft className="size-4" />
						</Button>
					)}
					<span className="font-medium">{currentFolderName}</span>
				</div>

				{/* File list */}
				<ScrollArea className="h-64 border rounded-md">
					{filesLoading ? (
						<div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading...</div>
					) : sorted.length === 0 ? (
						<div className="flex items-center justify-center h-full text-sm text-muted-foreground">
							No files in this folder
						</div>
					) : (
						<div className="p-1">
							{sorted.map((file) => (
								<button
									key={file.path}
									type="button"
									className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
										selectedPaths.has(file.path) ? "bg-primary/10 text-primary" : "hover:bg-muted"
									} ${file.isFolder ? "cursor-pointer" : "cursor-pointer"}`}
									onClick={() => {
										if (file.isFolder) {
											navigateInto(file)
										} else {
											toggleSelection(file)
										}
									}}
								>
									{file.isFolder ? (
										<IconFolder className="size-5 text-amber-500 shrink-0" />
									) : (
										<span className="shrink-0">{getFileIconLarge(file.mimeType, false)}</span>
									)}
									<span className="truncate flex-1">{file.name}</span>
									{!file.isFolder && (
										<span className="text-xs text-muted-foreground shrink-0">{formatSizeBytes(file.sizeBytes)}</span>
									)}
									{selectedPaths.has(file.path) && (
										<span className="text-xs font-medium text-primary shrink-0">Selected</span>
									)}
								</button>
							))}
						</div>
					)}
				</ScrollArea>

				<DialogFooter>
					<Button variant="outline" onClick={handleClose} disabled={loading}>
						Cancel
					</Button>
					<Button onClick={handleConfirm} disabled={loading || selectedPaths.size === 0}>
						{loading ? "Attaching..." : `Attach ${selectedPaths.size > 0 ? `(${selectedPaths.size})` : ""}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

export default MyFilesPicker
