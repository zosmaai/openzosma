"use client"

import { Button } from "@/src/components/ui/button"
import { Input } from "@/src/components/ui/input"
import useDeleteConversation from "@/src/hooks/chat/use-delete-conversation"
import useGetConversations from "@/src/hooks/chat/use-get-conversations"
import { cn } from "@/src/lib/utils"
import { IconMessageCircle, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

const ChatSidebar = ({ onNavigate }: { onNavigate?: () => void }) => {
	const router = useRouter()
	const pathname = usePathname()
	const [search, setSearch] = useState("")

	const activeconversationid = pathname.split("/chat/")[1] || null

	const { data: conversations = [], isLoading: loading } = useGetConversations()
	const deleteConversation = useDeleteConversation()

	const handledelete = async (conversationid: string, e: React.MouseEvent) => {
		e.stopPropagation()
		try {
			await deleteConversation.mutateAsync(conversationid)
			toast.success("Conversation deleted")
			if (activeconversationid === conversationid) {
				router.push("/chat")
			}
		} catch {
			toast.error("Failed to delete conversation")
		}
	}

	const filteredconversations = conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))

	const formattime = (datestr: string) => {
		const date = new Date(datestr)
		const now = new Date()
		const diffms = now.getTime() - date.getTime()
		const diffhrs = diffms / (1000 * 60 * 60)

		if (diffhrs < 1) return "Just now"
		if (diffhrs < 24) return `${Math.floor(diffhrs)}h ago`
		if (diffhrs < 48) return "Yesterday"
		return date.toLocaleDateString()
	}

	return (
		<div className="flex flex-col h-full w-full bg-sidebar border-r">
			{/* Header */}
			<div className="flex items-center justify-between p-4 border-b shrink-0">
				<h3 className="font-semibold text-sm">Conversations</h3>
				<Button size="icon-sm" variant="ghost" asChild>
					<Link href="/chat">
						<IconPlus className="size-4" />
					</Link>
				</Button>
			</div>

			{/* Search */}
			<div className="p-3 shrink-0">
				<div className="relative">
					<IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
					<Input
						placeholder="Search conversations..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="pl-8 h-8 text-sm"
					/>
				</div>
			</div>

			{/* Conversation List */}
			<div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
				<div className="flex flex-col gap-1 p-2">
					{loading ? (
						<p className="text-xs text-muted-foreground text-center py-8">Loading...</p>
					) : filteredconversations.length === 0 ? (
						<div className="flex flex-col items-center gap-3 py-8 px-4">
							<IconMessageCircle className="size-8 text-muted-foreground/50" />
							<p className="text-xs text-muted-foreground text-center">
								{search ? "No matching conversations" : "No conversations yet"}
							</p>
							{!search && (
								<Button size="sm" variant="outline" className="text-xs" asChild>
									<Link href="/chat">
										<IconPlus className="size-3" />
										Start a conversation
									</Link>
								</Button>
							)}
						</div>
					) : (
						filteredconversations.map((conv) => (
							<div
								key={conv.id}
								role="button"
								tabIndex={0}
								onClick={() => {
									router.push(`/chat/${conv.id}`)
									onNavigate?.()
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										router.push(`/chat/${conv.id}`)
										onNavigate?.()
									}
								}}
								className={cn(
									"group flex flex-col gap-1 rounded-lg p-3 text-left transition-colors cursor-pointer",
									activeconversationid === conv.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
								)}
							>
								{/* Title row */}
								<div className="flex items-center gap-2">
									<span
										className="text-sm font-medium flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
										style={{ minWidth: 0 }}
									>
										{conv.title}
									</span>
									<button
										type="button"
										onClick={(e) => handledelete(conv.id, e)}
										className="hidden group-hover:flex shrink-0 items-center justify-center w-6 h-6 rounded hover:bg-destructive/10"
										aria-label="Delete conversation"
									>
										<IconTrash className="size-3.5 text-muted-foreground hover:text-destructive" />
									</button>
								</div>
								{/* Subtitle row */}
								<div className="flex items-center gap-2">
									<span
										className="text-xs text-muted-foreground flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
										style={{ minWidth: 0 }}
									>
										{conv.lastmessage ?? "No messages yet"}
									</span>
									<span className="text-[10px] text-muted-foreground/70 shrink-0 whitespace-nowrap">
										{formattime(conv.updatedat)}
									</span>
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	)
}

export default ChatSidebar
