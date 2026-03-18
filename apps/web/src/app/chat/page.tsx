"use client"

import { useCallback, useEffect, useRef, useState } from "react"

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000"
const WS_URL = `${GATEWAY_URL.replace(/^http/, "ws")}/ws`

interface Message {
	id: string
	role: "user" | "assistant"
	content: string
}

interface AgentEvent {
	type: string
	id?: string
	text?: string
	error?: string
}

export default function ChatPage() {
	const [sessionId, setSessionId] = useState<string | null>(null)
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState("")
	const [isStreaming, setIsStreaming] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const wsRef = useRef<WebSocket | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const streamBufferRef = useRef("")
	const messagesLenRef = useRef(0)

	// Scroll to bottom when messages change
	useEffect(() => {
		if (messages.length !== messagesLenRef.current) {
			messagesLenRef.current = messages.length
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
		}
	})

	// Create session and connect WebSocket on mount
	useEffect(() => {
		let ws: WebSocket | null = null

		async function init() {
			try {
				const res = await fetch(`${GATEWAY_URL}/api/v1/sessions`, {
					method: "POST",
				})
				if (!res.ok) {
					throw new Error(`Failed to create session: ${res.status}`)
				}
				const data = await res.json()
				setSessionId(data.id)

				ws = new WebSocket(WS_URL)
				wsRef.current = ws

				ws.onmessage = (event) => {
					const msg: AgentEvent = JSON.parse(event.data)
					handleAgentEvent(msg)
				}

				ws.onerror = () => {
					setError("WebSocket connection error")
				}

				ws.onclose = () => {
					wsRef.current = null
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to connect")
			}
		}

		void init()

		return () => {
			if (ws) {
				ws.close()
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const handleAgentEvent = useCallback((event: AgentEvent) => {
		switch (event.type) {
			case "turn_start":
				setIsStreaming(true)
				streamBufferRef.current = ""
				break

			case "message_start":
				setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "" }])
				break

			case "message_update":
				if (event.text) {
					streamBufferRef.current += event.text
					const currentText = streamBufferRef.current
					setMessages((prev) => {
						const updated = [...prev]
						const last = updated[updated.length - 1]
						if (last && last.role === "assistant") {
							updated[updated.length - 1] = { ...last, content: currentText }
						}
						return updated
					})
				}
				break

			case "message_end":
				break

			case "turn_end":
				setIsStreaming(false)
				break

			case "error":
				setError(event.error || "Unknown error")
				setIsStreaming(false)
				break
		}
	}, [])

	const sendMessage = useCallback(() => {
		if (!input.trim() || !sessionId || !wsRef.current || isStreaming) return

		const content = input.trim()
		setInput("")
		setError(null)

		// Add user message immediately
		setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content }])

		// Send via WebSocket
		wsRef.current.send(JSON.stringify({ type: "message", sessionId, content }))
	}, [input, sessionId, isStreaming])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault()
				sendMessage()
			}
		},
		[sendMessage],
	)

	return (
		<div className="flex flex-col h-screen max-w-3xl mx-auto">
			{/* Header */}
			<header className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
				<h1 className="text-lg font-semibold">OpenZosma</h1>
				{sessionId && <span className="text-xs text-[var(--muted-foreground)]">{sessionId.slice(0, 8)}</span>}
			</header>

			{/* Messages */}
			<main className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
				{messages.length === 0 && (
					<div className="flex items-center justify-center h-full text-[var(--muted-foreground)]">
						<p>Send a message to start.</p>
					</div>
				)}

				{messages.map((msg) => (
					<div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
						<div
							className={`max-w-[80%] rounded-lg px-4 py-2 whitespace-pre-wrap ${
								msg.role === "user" ? "bg-[var(--accent)] text-white" : "bg-[var(--muted)] text-[var(--foreground)]"
							}`}
						>
							{msg.content}
							{msg.role === "assistant" && !msg.content && isStreaming && (
								<span className="inline-block w-2 h-4 bg-[var(--muted-foreground)] animate-pulse" />
							)}
						</div>
					</div>
				))}

				<div ref={messagesEndRef} />
			</main>

			{/* Error banner */}
			{error && <div className="px-6 py-2 text-sm text-red-400 bg-red-950/50 border-t border-red-900">{error}</div>}

			{/* Input */}
			<footer className="px-6 py-4 border-t border-[var(--border)]">
				<div className="flex gap-3">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Type a message..."
						disabled={!sessionId || isStreaming}
						className="flex-1 bg-[var(--muted)] text-[var(--foreground)] rounded-lg px-4 py-2.5 outline-none placeholder:text-[var(--muted-foreground)] disabled:opacity-50"
					/>
					<button
						type="button"
						onClick={sendMessage}
						disabled={!input.trim() || !sessionId || isStreaming}
						className="bg-[var(--accent)] text-white px-5 py-2.5 rounded-lg font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
					>
						Send
					</button>
				</div>
			</footer>
		</div>
	)
}
