"use client"

import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"

// UI Components
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/src/components/ui/breadcrumb"
import { Button } from "@/src/components/ui/button"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/src/components/ui/context-menu"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/src/components/ui/dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/src/components/ui/dropdown-menu"
import { Input } from "@/src/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/src/components/ui/resizable"
import { ScrollArea } from "@/src/components/ui/scroll-area"
import { Separator } from "@/src/components/ui/separator"
import { Skeleton } from "@/src/components/ui/skeleton"

// Hooks
import {
	useCreateFolder,
	useDeleteFile,
	useFileList,
	useFileTree,
	useRenameFile,
	useUploadFiles,
} from "@/src/hooks/use-files"
import type { FileEntry } from "@/src/services/files.services"
import filesService from "@/src/services/files.services"

// Utils
import { formatSizeBytes, getFileIconLarge, getFileTypeLabel } from "@/src/utils/file-utils"

// Icons
import {
	IconChevronRight,
	IconDots,
	IconDownload,
	IconFile,
	IconFolder,
	IconFolderOpen,
	IconFolderPlus,
	IconGridDots,
	IconLayoutList,
	IconPencil,
	IconTrash,
	IconUpload,
} from "@tabler/icons-react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = "grid" | "list"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the parent directory path from a full path. */
const parentPath = (p: string): string => {
	const idx = p.lastIndexOf("/")
	if (idx <= 0) return "/"
	return p.slice(0, idx)
}

/** Build breadcrumb segments from a path like "/docs/reports" → [{"/", "My Files"}, {"/docs", "docs"}, {"/docs/reports", "reports"}] */
const buildBreadcrumbs = (path: string): Array<{ path: string; name: string }> => {
	const crumbs: Array<{ path: string; name: string }> = [{ path: "/", name: "My Files" }]
	if (path === "/" || path === "") return crumbs

	const parts = path.split("/").filter(Boolean)
	let accumulated = ""
	for (const part of parts) {
		accumulated += `/${part}`
		crumbs.push({ path: accumulated, name: part })
	}
	return crumbs
}

/** Check if a path is under ai-generated/ */
const isAiGenerated = (path: string): boolean => {
	return path.startsWith("/ai-generated/") || path === "/ai-generated"
}

// ---------------------------------------------------------------------------
// FilesPage
// ---------------------------------------------------------------------------

const FilesPage = () => {
	// State -- path-based navigation
	const [currentPath, setCurrentPath] = useState<string>("/")
	const [viewMode, setViewMode] = useState<ViewMode>("list")
	const [isDragging, setIsDragging] = useState(false)

	// Dialogs
	const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
	const [renameValue, setRenameValue] = useState("")
	const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)
	const [newFolderOpen, setNewFolderOpen] = useState(false)
	const [newFolderName, setNewFolderName] = useState("")

	const fileInputRef = useRef<HTMLInputElement>(null)

	// Queries
	const { data: treeEntries } = useFileTree()
	const { data: currentFiles, isLoading: filesLoading } = useFileList(currentPath)

	// Mutations
	const uploadMutation = useUploadFiles()
	const createFolderMutation = useCreateFolder()
	const renameMutation = useRenameFile()
	const deleteMutation = useDeleteFile()

	// Breadcrumbs derived from current path
	const breadcrumbs = buildBreadcrumbs(currentPath)

	// -----------------------------------------------------------------------
	// Navigation
	// -----------------------------------------------------------------------

	const navigateToFolder = useCallback((folder: FileEntry) => {
		setCurrentPath(folder.path)
	}, [])

	const navigateToBreadcrumb = useCallback((entry: { path: string }) => {
		setCurrentPath(entry.path)
	}, [])

	// -----------------------------------------------------------------------
	// File actions
	// -----------------------------------------------------------------------

	const handleUpload = useCallback(
		(files: FileList | File[]) => {
			const fileArray = Array.from(files)
			if (fileArray.length === 0) return

			uploadMutation.mutate(
				{ files: fileArray, dirPath: currentPath },
				{
					onSuccess: (uploaded) => {
						toast.success(`Uploaded ${uploaded.length} file(s)`)
					},
					onError: () => {
						toast.error("Upload failed")
					},
				},
			)
		},
		[currentPath, uploadMutation],
	)

	const handleCreateFolder = useCallback(() => {
		const name = newFolderName.trim()
		if (!name) return

		// Build full path: currentPath + "/" + name
		const folderPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`

		createFolderMutation.mutate(folderPath, {
			onSuccess: () => {
				toast.success(`Created folder "${name}"`)
				setNewFolderOpen(false)
				setNewFolderName("")
			},
			onError: () => {
				toast.error("Failed to create folder")
			},
		})
	}, [newFolderName, currentPath, createFolderMutation])

	const handleRename = useCallback(() => {
		if (!renameTarget) return
		const newName = renameValue.trim()
		if (!newName || newName === renameTarget.name) {
			setRenameTarget(null)
			return
		}

		const from = renameTarget.path
		const parent = parentPath(renameTarget.path)
		const to = parent === "/" ? `/${newName}` : `${parent}/${newName}`

		renameMutation.mutate(
			{ from, to },
			{
				onSuccess: () => {
					toast.success(`Renamed to "${newName}"`)
					setRenameTarget(null)
				},
				onError: () => {
					toast.error("Failed to rename")
				},
			},
		)
	}, [renameTarget, renameValue, renameMutation])

	const handleDelete = useCallback(() => {
		if (!deleteTarget) return

		deleteMutation.mutate(deleteTarget.path, {
			onSuccess: () => {
				toast.success(`Deleted "${deleteTarget.name}"`)
				setDeleteTarget(null)
			},
			onError: () => {
				toast.error("Failed to delete")
			},
		})
	}, [deleteTarget, deleteMutation])

	const openRename = useCallback((file: FileEntry) => {
		setRenameTarget(file)
		setRenameValue(file.name)
	}, [])

	const openDelete = useCallback((file: FileEntry) => {
		setDeleteTarget(file)
	}, [])

	const handleDownload = useCallback((file: FileEntry) => {
		const url = filesService.getDownloadUrl(file.path, true)
		window.open(url, "_blank")
	}, [])

	const handleFileClick = useCallback(
		(file: FileEntry) => {
			if (file.isFolder) {
				navigateToFolder(file)
			} else {
				// Open preview / download
				const url = filesService.getDownloadUrl(file.path)
				window.open(url, "_blank")
			}
		},
		[navigateToFolder],
	)

	// -----------------------------------------------------------------------
	// Drag-and-drop
	// -----------------------------------------------------------------------

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(true)
	}, [])

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(false)
	}, [])

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			e.stopPropagation()
			setIsDragging(false)

			if (e.dataTransfer.files.length > 0) {
				handleUpload(e.dataTransfer.files)
			}
		},
		[handleUpload],
	)

	// -----------------------------------------------------------------------
	// Folder tree (sidebar) -- uses tree response with nested children
	// -----------------------------------------------------------------------

	/** Extract folder entries from the tree (recursive). */
	const extractFolders = (entries: FileEntry[]): FileEntry[] => {
		return entries.filter((e) => e.isFolder)
	}

	const rootFolders = extractFolders(treeEntries ?? [])

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	return (
		<div className="flex flex-col w-full h-[calc(100vh-2rem)] overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between mb-4 shrink-0">
				<div>
					<h4 className="text-xl font-semibold">Files</h4>
					<p className="text-sm text-muted-foreground">Manage your uploaded and AI-generated files</p>
				</div>
			</div>

			{/* Main layout — resizable panels */}
			<ResizablePanelGroup direction="horizontal" className="flex-1 border rounded-lg overflow-hidden min-h-0">
				{/* Left sidebar — Folder tree */}
				<ResizablePanel defaultSize={20} minSize={12} maxSize={40}>
					<div className="flex flex-col h-full bg-muted/30">
						<div className="p-3 font-medium text-sm text-muted-foreground shrink-0">Folders</div>
						<ScrollArea className="flex-1 h-0">
							<div className="px-2 pb-2">
								<FolderTreeItem
									label="My Files"
									folderPath="/"
									isActive={currentPath === "/"}
									depth={0}
									onClick={() => setCurrentPath("/")}
									childFolders={rootFolders}
									currentPath={currentPath}
									onNavigate={(folder) => setCurrentPath(folder.path)}
								/>
							</div>
						</ScrollArea>
					</div>
				</ResizablePanel>

				<ResizableHandle />

				{/* Right panel — File list */}
				<ResizablePanel defaultSize={80}>
					<div
						className="flex flex-col h-full"
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
					>
						{/* Toolbar */}
						<div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20 shrink-0">
							<Breadcrumb>
								<BreadcrumbList>
									{breadcrumbs.map((entry, i) => (
										<BreadcrumbItem key={entry.path}>
											{i > 0 && <BreadcrumbSeparator />}
											{i === breadcrumbs.length - 1 ? (
												<BreadcrumbPage>{entry.name}</BreadcrumbPage>
											) : (
												<BreadcrumbLink className="cursor-pointer" onClick={() => navigateToBreadcrumb(entry)}>
													{entry.name}
												</BreadcrumbLink>
											)}
										</BreadcrumbItem>
									))}
								</BreadcrumbList>
							</Breadcrumb>

							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									className={viewMode === "list" ? "bg-muted" : ""}
									onClick={() => setViewMode("list")}
								>
									<IconLayoutList className="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									className={viewMode === "grid" ? "bg-muted" : ""}
									onClick={() => setViewMode("grid")}
								>
									<IconGridDots className="size-4" />
								</Button>
								<Separator orientation="vertical" className="h-5 mx-1" />
								<Button variant="outline" size="sm" onClick={() => setNewFolderOpen(true)}>
									<IconFolderPlus className="size-4 mr-1" />
									New Folder
								</Button>
								<Button
									variant="default"
									size="sm"
									onClick={() => fileInputRef.current?.click()}
									disabled={uploadMutation.isPending}
								>
									<IconUpload className="size-4 mr-1" />
									{uploadMutation.isPending ? "Uploading..." : "Upload"}
								</Button>
								<input
									ref={fileInputRef}
									type="file"
									multiple
									className="hidden"
									onChange={(e) => {
										if (e.target.files) {
											handleUpload(e.target.files)
											e.target.value = ""
										}
									}}
								/>
							</div>
						</div>

						{/* Content area */}
						<ScrollArea className="flex-1 h-0">
							{isDragging ? (
								<DropZoneOverlay />
							) : filesLoading ? (
								<LoadingSkeleton viewMode={viewMode} />
							) : !currentFiles || currentFiles.length === 0 ? (
								<EmptyState onUpload={() => fileInputRef.current?.click()} onNewFolder={() => setNewFolderOpen(true)} />
							) : viewMode === "list" ? (
								<FileListView
									files={currentFiles}
									onFileClick={handleFileClick}
									onRename={openRename}
									onDelete={openDelete}
									onDownload={handleDownload}
								/>
							) : (
								<FileGridView
									files={currentFiles}
									onFileClick={handleFileClick}
									onRename={openRename}
									onDelete={openDelete}
									onDownload={handleDownload}
								/>
							)}
						</ScrollArea>
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>

			{/* Dialogs */}
			<NewFolderDialog
				open={newFolderOpen}
				name={newFolderName}
				onNameChange={setNewFolderName}
				onConfirm={handleCreateFolder}
				onCancel={() => {
					setNewFolderOpen(false)
					setNewFolderName("")
				}}
				isPending={createFolderMutation.isPending}
			/>

			<RenameDialog
				target={renameTarget}
				value={renameValue}
				onValueChange={setRenameValue}
				onConfirm={handleRename}
				onCancel={() => setRenameTarget(null)}
				isPending={renameMutation.isPending}
			/>

			<DeleteDialog
				target={deleteTarget}
				onConfirm={handleDelete}
				onCancel={() => setDeleteTarget(null)}
				isPending={deleteMutation.isPending}
			/>
		</div>
	)
}

export default FilesPage

// ---------------------------------------------------------------------------
// FolderTreeItem - recursive sidebar folder
// ---------------------------------------------------------------------------

interface FolderTreeItemProps {
	label: string
	folderPath: string
	isActive: boolean
	depth: number
	onClick: () => void
	childFolders: FileEntry[]
	currentPath: string
	onNavigate: (folder: FileEntry) => void
}

const FolderTreeItem = ({
	label,
	isActive,
	depth,
	onClick,
	childFolders,
	currentPath,
	onNavigate,
}: FolderTreeItemProps) => {
	const [expanded, setExpanded] = useState(depth === 0)

	const hasChildren = childFolders.length > 0

	return (
		<div>
			<button
				type="button"
				className={`flex items-center gap-1.5 w-full text-left text-sm px-2 py-1.5 rounded-md transition-colors ${
					isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-muted"
				}`}
				style={{ paddingLeft: `${depth * 12 + 8}px` }}
				onClick={() => {
					onClick()
					if (hasChildren && !expanded) {
						setExpanded(true)
					}
				}}
			>
				{hasChildren ? (
					<button
						type="button"
						className="p-0.5 -ml-1 hover:bg-muted rounded"
						onClick={(e) => {
							e.stopPropagation()
							setExpanded((prev) => !prev)
						}}
					>
						<IconChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
					</button>
				) : (
					<span className="w-4" />
				)}
				{expanded && hasChildren ? (
					<IconFolderOpen className="size-4 text-amber-500 shrink-0" />
				) : (
					<IconFolder className="size-4 text-amber-500 shrink-0" />
				)}
				<span className="truncate">{label}</span>
			</button>
			{expanded &&
				childFolders.map((child) => (
					<FolderTreeItem
						key={child.path}
						label={child.name}
						folderPath={child.path}
						isActive={currentPath === child.path}
						depth={depth + 1}
						onClick={() => onNavigate(child)}
						childFolders={(child.children ?? []).filter((c) => c.isFolder)}
						currentPath={currentPath}
						onNavigate={onNavigate}
					/>
				))}
		</div>
	)
}

// ---------------------------------------------------------------------------
// FileListView
// ---------------------------------------------------------------------------

interface FileViewProps {
	files: FileEntry[]
	onFileClick: (file: FileEntry) => void
	onRename: (file: FileEntry) => void
	onDelete: (file: FileEntry) => void
	onDownload: (file: FileEntry) => void
}

const FileListView = ({ files, onFileClick, onRename, onDelete, onDownload }: FileViewProps) => {
	// Sort: folders first, then alphabetical
	const sorted = [...files].sort((a, b) => {
		if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
		return a.name.localeCompare(b.name)
	})

	return (
		<div className="p-2">
			{/* Header row */}
			<div className="grid grid-cols-[1fr_120px_120px_100px_40px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
				<span>Name</span>
				<span>Type</span>
				<span>Size</span>
				<span>Modified</span>
				<span />
			</div>
			{sorted.map((file) => (
				<FileListRow
					key={file.path}
					file={file}
					onClick={() => onFileClick(file)}
					onRename={() => onRename(file)}
					onDelete={() => onDelete(file)}
					onDownload={() => onDownload(file)}
				/>
			))}
		</div>
	)
}

interface FileListRowProps {
	file: FileEntry
	onClick: () => void
	onRename: () => void
	onDelete: () => void
	onDownload: () => void
}

const FileListRow = ({ file, onClick, onRename, onDelete, onDownload }: FileListRowProps) => {
	const dateStr = new Date(file.modifiedAt).toLocaleDateString()

	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<div
					className="grid grid-cols-[1fr_120px_120px_100px_40px] gap-2 px-3 py-2 rounded-md hover:bg-muted/50 cursor-pointer items-center group"
					onClick={onClick}
					onKeyDown={(e) => {
						if (e.key === "Enter") onClick()
					}}
					role="button"
					tabIndex={0}
				>
					<div className="flex items-center gap-2 min-w-0">
						{file.isFolder ? (
							<IconFolder className="size-5 text-amber-500 shrink-0" />
						) : (
							<span className="shrink-0">{getFileIconLarge(file.mimeType, false)}</span>
						)}
						<span className="truncate text-sm">{file.name}</span>
						{isAiGenerated(file.path) && (
							<span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded shrink-0">
								AI
							</span>
						)}
					</div>
					<span className="text-sm text-muted-foreground">{getFileTypeLabel(file.mimeType, file.isFolder)}</span>
					<span className="text-sm text-muted-foreground">
						{file.isFolder ? "--" : formatSizeBytes(file.sizeBytes)}
					</span>
					<span className="text-sm text-muted-foreground">{dateStr}</span>
					<div className="opacity-0 group-hover:opacity-100">
						<FileActions file={file} onRename={onRename} onDelete={onDelete} onDownload={onDownload} />
					</div>
				</div>
			</ContextMenuTrigger>
			<FileContextMenuContent file={file} onRename={onRename} onDelete={onDelete} onDownload={onDownload} />
		</ContextMenu>
	)
}

// ---------------------------------------------------------------------------
// FileGridView
// ---------------------------------------------------------------------------

const FileGridView = ({ files, onFileClick, onRename, onDelete, onDownload }: FileViewProps) => {
	const sorted = [...files].sort((a, b) => {
		if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
		return a.name.localeCompare(b.name)
	})

	return (
		<div className="p-4 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
			{sorted.map((file) => (
				<FileGridCard
					key={file.path}
					file={file}
					onClick={() => onFileClick(file)}
					onRename={() => onRename(file)}
					onDelete={() => onDelete(file)}
					onDownload={() => onDownload(file)}
				/>
			))}
		</div>
	)
}

interface FileGridCardProps {
	file: FileEntry
	onClick: () => void
	onRename: () => void
	onDelete: () => void
	onDownload: () => void
}

const FileGridCard = ({ file, onClick, onRename, onDelete, onDownload }: FileGridCardProps) => {
	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<div
					className="flex flex-col items-center gap-2 p-4 rounded-lg border hover:bg-muted/50 cursor-pointer group relative"
					onClick={onClick}
					onKeyDown={(e) => {
						if (e.key === "Enter") onClick()
					}}
					role="button"
					tabIndex={0}
				>
					<div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100">
						<FileActions file={file} onRename={onRename} onDelete={onDelete} onDownload={onDownload} />
					</div>
					{file.isFolder ? (
						<IconFolder className="size-10 text-amber-500" />
					) : (
						<IconFile className="size-10 text-muted-foreground" />
					)}
					<div className="text-center min-w-0 w-full">
						<p className="text-sm truncate" title={file.name}>
							{file.name}
						</p>
						<p className="text-xs text-muted-foreground">
							{file.isFolder ? "Folder" : formatSizeBytes(file.sizeBytes)}
						</p>
					</div>
					{isAiGenerated(file.path) && (
						<span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
							AI
						</span>
					)}
				</div>
			</ContextMenuTrigger>
			<FileContextMenuContent file={file} onRename={onRename} onDelete={onDelete} onDownload={onDownload} />
		</ContextMenu>
	)
}

// ---------------------------------------------------------------------------
// FileActions (dropdown "..." button)
// ---------------------------------------------------------------------------

interface FileActionsProps {
	file: FileEntry
	onRename: () => void
	onDelete: () => void
	onDownload: () => void
}

const FileActions = ({ file, onRename, onDelete, onDownload }: FileActionsProps) => {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className="size-7 p-0" onClick={(e) => e.stopPropagation()}>
					<IconDots className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
				{!file.isFolder && (
					<DropdownMenuItem onClick={onDownload}>
						<IconDownload className="size-4 mr-2" />
						Download
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onClick={onRename}>
					<IconPencil className="size-4 mr-2" />
					Rename
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
					<IconTrash className="size-4 mr-2" />
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// ---------------------------------------------------------------------------
// FileContextMenuContent (right-click)
// ---------------------------------------------------------------------------

interface FileContextMenuContentProps {
	file: FileEntry
	onRename: () => void
	onDelete: () => void
	onDownload: () => void
}

const FileContextMenuContent = ({ file, onRename, onDelete, onDownload }: FileContextMenuContentProps) => {
	return (
		<ContextMenuContent>
			{!file.isFolder && (
				<ContextMenuItem onClick={onDownload}>
					<IconDownload className="size-4 mr-2" />
					Download
				</ContextMenuItem>
			)}
			<ContextMenuItem onClick={onRename}>
				<IconPencil className="size-4 mr-2" />
				Rename
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
				<IconTrash className="size-4 mr-2" />
				Delete
			</ContextMenuItem>
		</ContextMenuContent>
	)
}

// ---------------------------------------------------------------------------
// DropZoneOverlay
// ---------------------------------------------------------------------------

const DropZoneOverlay = () => {
	return (
		<div className="flex flex-col items-center justify-center h-full min-h-[300px] border-2 border-dashed border-primary/40 bg-primary/5 rounded-lg m-4">
			<IconUpload className="size-12 text-primary/50 mb-3" />
			<p className="text-lg font-medium text-primary/70">Drop files here to upload</p>
			<p className="text-sm text-muted-foreground">Files will be uploaded to the current folder</p>
		</div>
	)
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

interface EmptyStateProps {
	onUpload: () => void
	onNewFolder: () => void
}

const EmptyState = ({ onUpload, onNewFolder }: EmptyStateProps) => {
	return (
		<div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center px-4">
			<IconFile className="size-12 text-muted-foreground/30 mb-3" />
			<p className="text-lg font-medium text-muted-foreground mb-1">No files here</p>
			<p className="text-sm text-muted-foreground mb-4">
				Upload files or create a folder to get started. You can also drag and drop files.
			</p>
			<div className="flex gap-2">
				<Button variant="outline" size="sm" onClick={onNewFolder}>
					<IconFolderPlus className="size-4 mr-1" />
					New Folder
				</Button>
				<Button variant="default" size="sm" onClick={onUpload}>
					<IconUpload className="size-4 mr-1" />
					Upload Files
				</Button>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// LoadingSkeleton
// ---------------------------------------------------------------------------

const LoadingSkeleton = ({ viewMode }: { viewMode: ViewMode }) => {
	if (viewMode === "grid") {
		return (
			<div className="p-4 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
				{Array.from({ length: 8 }).map((_, i) => (
					<Skeleton key={i} className="h-32 rounded-lg" />
				))}
			</div>
		)
	}

	return (
		<div className="p-2 space-y-1">
			{Array.from({ length: 6 }).map((_, i) => (
				<Skeleton key={i} className="h-10 rounded-md" />
			))}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

interface NewFolderDialogProps {
	open: boolean
	name: string
	onNameChange: (v: string) => void
	onConfirm: () => void
	onCancel: () => void
	isPending: boolean
}

const NewFolderDialog = ({ open, name, onNameChange, onConfirm, onCancel, isPending }: NewFolderDialogProps) => {
	return (
		<Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New Folder</DialogTitle>
					<DialogDescription>Enter a name for the new folder.</DialogDescription>
				</DialogHeader>
				<Input
					value={name}
					onChange={(e) => onNameChange(e.target.value)}
					placeholder="Folder name"
					onKeyDown={(e) => {
						if (e.key === "Enter") onConfirm()
					}}
					autoFocus
				/>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel} disabled={isPending}>
						Cancel
					</Button>
					<Button onClick={onConfirm} disabled={isPending || !name.trim()}>
						{isPending ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

interface RenameDialogProps {
	target: FileEntry | null
	value: string
	onValueChange: (v: string) => void
	onConfirm: () => void
	onCancel: () => void
	isPending: boolean
}

const RenameDialog = ({ target, value, onValueChange, onConfirm, onCancel, isPending }: RenameDialogProps) => {
	return (
		<Dialog open={!!target} onOpenChange={(v) => !v && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Rename {target?.isFolder ? "Folder" : "File"}</DialogTitle>
					<DialogDescription>Enter a new name for &ldquo;{target?.name}&rdquo;.</DialogDescription>
				</DialogHeader>
				<Input
					value={value}
					onChange={(e) => onValueChange(e.target.value)}
					placeholder="New name"
					onKeyDown={(e) => {
						if (e.key === "Enter") onConfirm()
					}}
					autoFocus
				/>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel} disabled={isPending}>
						Cancel
					</Button>
					<Button onClick={onConfirm} disabled={isPending || !value.trim()}>
						{isPending ? "Renaming..." : "Rename"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

interface DeleteDialogProps {
	target: FileEntry | null
	onConfirm: () => void
	onCancel: () => void
	isPending: boolean
}

const DeleteDialog = ({ target, onConfirm, onCancel, isPending }: DeleteDialogProps) => {
	return (
		<Dialog open={!!target} onOpenChange={(v) => !v && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete {target?.isFolder ? "Folder" : "File"}</DialogTitle>
					<DialogDescription>
						Are you sure you want to delete &ldquo;{target?.name}&rdquo;?
						{target?.isFolder && " This will also delete all files inside it."} This action cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel} disabled={isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm} disabled={isPending}>
						{isPending ? "Deleting..." : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
