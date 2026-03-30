"use client"

import { Button } from "@/src/components/ui/button"
import { ScrollArea } from "@/src/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/src/components/ui/tooltip"
import { formatSizeBytes, getFileIcon, isPreviewable } from "@/src/utils/file-utils"
import { DownloadIcon, ExternalLinkIcon, EyeIcon, FileIcon, XIcon } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import type { FileArtifact } from "./types"

type FilesPanelProps = {
	artifacts: FileArtifact[]
	onClose: () => void
	onPreview: (artifact: FileArtifact) => void
}

const FilesPanel = ({ artifacts, onClose, onPreview }: FilesPanelProps) => {
	const { conversationid } = useParams<{ conversationid: string }>()

	return (
		<div className="flex flex-col h-full w-80 border-l bg-background shrink-0">
			{/* Panel header */}
			<div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
				<div className="flex items-center gap-2">
					<FileIcon className="size-4 text-muted-foreground" />
					<h3 className="font-semibold text-sm">Files</h3>
					{artifacts.length > 0 && (
						<span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
							{artifacts.length}
						</span>
					)}
				</div>
				<Button variant="ghost" size="icon-sm" onClick={onClose}>
					<XIcon className="size-3.5" />
					<span className="sr-only">Close files panel</span>
				</Button>
			</div>

			{/* File list */}
			<ScrollArea className="flex-1 h-0">
				{artifacts.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 px-4 text-center">
						<FileIcon className="size-8 text-muted-foreground/30 mb-3" />
						<p className="text-sm text-muted-foreground">No files generated yet</p>
						<p className="text-xs text-muted-foreground/70 mt-1">Files created by the agent will appear here</p>
					</div>
				) : (
					<div className="p-2 space-y-1">
						{artifacts.map((artifact) => {
							const downloadUrl = `/api/conversations/${conversationid}/artifacts/${encodeURIComponent(artifact.filename)}?download=true`
							const canPreview = isPreviewable(artifact.mediatype)

							return (
								<div
									key={artifact.filename}
									className="flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent/50 transition-colors group"
								>
									{getFileIcon(artifact.mediatype)}
									<div className="min-w-0 flex-1">
										<p className="truncate text-xs font-medium">{artifact.filename}</p>
										<p className="text-[10px] text-muted-foreground">{formatSizeBytes(artifact.sizebytes)}</p>
									</div>
									<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
										{canPreview && (
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger asChild>
														<Button variant="ghost" size="icon-sm" onClick={() => onPreview(artifact)}>
															<EyeIcon className="size-3" />
															<span className="sr-only">Preview</span>
														</Button>
													</TooltipTrigger>
													<TooltipContent side="left">Preview</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										)}
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button variant="ghost" size="icon-sm" asChild>
														<a href={downloadUrl} download={artifact.filename}>
															<DownloadIcon className="size-3" />
															<span className="sr-only">Download</span>
														</a>
													</Button>
												</TooltipTrigger>
												<TooltipContent side="left">Download</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									</div>
								</div>
							)
						})}
					</div>
				)}
			</ScrollArea>

			{/* Link to Files page */}
			{artifacts.length > 0 && (
				<div className="border-t px-4 py-2.5 shrink-0">
					<Link
						href="/files"
						className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						<ExternalLinkIcon className="size-3" />
						View all in Files
					</Link>
				</div>
			)}
		</div>
	)
}

export default FilesPanel
