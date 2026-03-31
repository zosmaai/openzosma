"use client"

import type { PromptInputMessage } from "@/src/components/ai-elements/prompt-input"
import PromptInput from "@/src/components/organisms/chat-view/prompt-input"
import useCreateConversation from "@/src/hooks/chat/use-create-conversation"
import { setPendingMessage } from "@/src/lib/pending-message"
import { motion } from "framer-motion"
import { useRouter } from "next/navigation"
import { useRef } from "react"
import { toast } from "sonner"

const SUGGESTIONS = [
	{
		label: "Explore my databases",
		prompt: "What databases and tables do I have connected?",
	},
	{
		label: "Visualize trends",
		prompt: "Show me a chart of the most important trends in my data",
	},
	{
		label: "Generate a report",
		prompt: "Generate a summary report of my data from last month",
	},
	{
		label: "Ask anything",
		prompt: "What insights can you find in my data?",
	},
]

const ChatPage = () => {
	const router = useRouter()
	const textarearef = useRef<HTMLTextAreaElement>(null)
	const createConversation = useCreateConversation()

	const handlesubmit = async (message: PromptInputMessage) => {
		if (!message.text.trim()) return

		try {
			const conversation = await createConversation.mutateAsync({
				title: message.text.slice(0, 80) || "New Conversation",
				agentid: "dbchatagent",
				agentname: "Open Zosma Agent",
			})
			setPendingMessage(message.text)
			router.push(`/chat/${conversation.id}`)
		} catch {
			toast.error("Failed to start conversation")
		}
	}

	const handlesuggestionclick = (prompt: string) => {
		if (textarearef.current) {
			textarearef.current.value = prompt
			textarearef.current.dispatchEvent(new Event("input", { bubbles: true }))
			textarearef.current.focus()
		}
	}

	return (
		<div className="flex flex-col items-center justify-center h-full w-full px-4">
			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.4, ease: [0.25, 0, 0, 1] }}
				className="flex flex-col items-center w-full max-w-2xl gap-8"
			>
				{/* Heading */}
				<h1 className="text-3xl font-semibold tracking-tight">How can I help you today?</h1>

				{/* Prompt input */}
				<div className="w-full">
					<PromptInput
						handlesubmit={handlesubmit}
						hasmessages={false}
						textarearef={textarearef as React.RefObject<HTMLTextAreaElement>}
						streaming={false}
					/>
				</div>

				{/* Suggestions */}
				<div className="grid grid-cols-2 gap-2 w-full">
					{SUGGESTIONS.map((s, i) => (
						<motion.button
							key={s.label}
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.3, delay: 0.1 + i * 0.05 }}
							onClick={() => handlesuggestionclick(s.prompt)}
							className="group flex flex-col items-start gap-0.5 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-muted"
						>
							<span className="text-sm font-medium">{s.label}</span>
							<span className="text-xs text-muted-foreground line-clamp-1">{s.prompt}</span>
						</motion.button>
					))}
				</div>
			</motion.div>
		</div>
	)
}

export default ChatPage
