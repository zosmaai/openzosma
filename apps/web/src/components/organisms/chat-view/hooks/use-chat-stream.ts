"use client"

import useSaveMessage from "@/src/hooks/chat/use-save-message"
import { useSession } from "@/src/lib/auth-client"
import { GATEWAY_URL } from "@/src/lib/constants"
import { QUERY_KEYS } from "@/src/utils/query-keys"
import type { AgentStreamEvent, AgentStreamEventType } from "@openzosma/agents/types"

/** Gateway may emit additional event types beyond what the agent SDK defines. */
type GatewayEventType = AgentStreamEventType | "file_output"

interface GatewayStreamEvent extends Omit<AgentStreamEvent, "type"> {
	type: GatewayEventType
	artifacts?: FileArtifact[]
}
import { useQueryClient } from "@tanstack/react-query"
import type { FileUIPart } from "ai"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import type {
	ChatAttachment,
	ChatMessage,
	ChatParticipant,
	ConversationData,
	FileArtifact,
	MessageSegment,
	StreamToolCall,
} from "../types"

type SubmitMessage = {
	text: string
	files: FileUIPart[]
}

type UseChatStreamReturn = {
	streaming: boolean
	streamingcontent: string
	streamingtoolcalls: StreamToolCall[]
	streamingsegments: MessageSegment[]
	streamingreasoning: string
	streamingartifacts: FileArtifact[]
	handlesubmit: (message: SubmitMessage) => Promise<void>
}

const useChatStream = (
	conversationid: string,
	conversation: ConversationData | null,
	participants: ChatParticipant[],
): UseChatStreamReturn => {
	const queryClient = useQueryClient()
	const { mutateAsync: saveMessage } = useSaveMessage()
	const { data: session } = useSession()

	const [streaming, setStreaming] = useState(false)
	const [streamingcontent, setStreamingcontent] = useState("")
	const [streamingtoolcalls, setStreamingtoolcalls] = useState<StreamToolCall[]>([])
	const [streamingsegments, setStreamingsegments] = useState<MessageSegment[]>([])
	const [streamingreasoning, setStreamingreasoning] = useState("")
	const [streamingartifacts, setStreamingartifacts] = useState<FileArtifact[]>([])

	const handlesubmit = useCallback(
		async (message: SubmitMessage) => {
			if (!message.text.trim() && message.files.length === 0) return

			const userid = conversation?.createdby || "unknown"

			// Optimistically insert the user message into the query cache
			const usermsg: ChatMessage = {
				id: `temp-${Date.now()}`,
				sendertype: "human",
				senderid: userid,
				content: message.text,
				metadata: {},
				createdat: new Date().toISOString(),
				attachments: message.files.map(
					(f, i): ChatAttachment => ({
						id: `temp-att-${i}`,
						type: f.mediaType?.startsWith("image/") ? "media" : "file",
						filename: f.filename || null,
						mediatype: f.mediaType || null,
						url: f.url || null,
						sizebytes: null,
						metadata: {},
					}),
				),
			}
			queryClient.setQueryData(
				[QUERY_KEYS.CONVERSATION, conversationid],
				(
					old:
						| {
								conversation: ConversationData
								participants: ChatParticipant[]
								messages: ChatMessage[]
						  }
						| undefined,
				) => {
					if (!old) return old
					return { ...old, messages: [...old.messages, usermsg] }
				},
			)

			try {
				await saveMessage({
					conversationid,
					payload: {
						sendertype: "human",
						senderid: userid,
						content: message.text,
						attachments: message.files.map((f) => ({
							type: f.mediaType?.startsWith("image/") ? "media" : "file",
							filename: f.filename ?? "",
							mediatype: f.mediaType ?? "",
							url: f.url ?? "",
							sizebytes: 0,
						})),
					},
				})
			} catch (err) {
				console.error("Failed to save user message:", err)
			}

			const agentparticipant = participants.find((p) => p.participanttype === "agent")
			if (!agentparticipant) {
				queryClient.invalidateQueries({
					queryKey: [QUERY_KEYS.CONVERSATION, conversationid],
				})
				return
			}

			setStreaming(true)
			setStreamingcontent("")
			setStreamingtoolcalls([])
			setStreamingsegments([])
			setStreamingreasoning("")
			setStreamingartifacts([])

			try {
				const wsurl = `${GATEWAY_URL.replace(/^http/, "ws")}/ws`
				const ws = new WebSocket(wsurl)
				let fullcontent = ""
				let fullreasoning = ""
				const toolcalls = new Map<string, StreamToolCall>()
				const segments: MessageSegment[] = []
				const allartifacts: FileArtifact[] = []

				const updatetoolcalls = () => {
					setStreamingtoolcalls(Array.from(toolcalls.values()))
				}

				const updatesegments = () => {
					setStreamingsegments([...segments])
				}

				await new Promise<void>((resolve, reject) => {
					ws.onopen = () => {
						// Build attachments array from file parts
						const attachments =
							message.files.length > 0
								? message.files
										.filter((f) => f.url)
										.map((f) => ({
											filename: f.filename || "file",
											mediaType: f.mediaType || "application/octet-stream",
											dataUrl: f.url,
										}))
								: undefined

						ws.send(
							JSON.stringify({
								type: "message",
								sessionId: conversationid,
								content: message.text,
								userId: session?.user?.id,
								attachments,
							}),
						)
					}

					ws.onmessage = (event) => {
						let evt: GatewayStreamEvent
						try {
							evt = JSON.parse(event.data)
						} catch {
							return
						}

						switch (evt.type) {
							case "message_update": {
								if (evt.text) {
									fullcontent += evt.text
									setStreamingcontent(fullcontent)
									const last = segments[segments.length - 1]
									if (last?.type === "text") {
										last.content += evt.text
									} else {
										segments.push({ type: "text", content: evt.text })
									}
									updatesegments()
								}
								break
							}
							case "tool_call_start": {
								const { toolCallId, toolName, toolArgs } = evt
								if (toolCallId) {
									let parsedargs: Record<string, unknown> | string = {}
									if (toolArgs) {
										try {
											parsedargs = JSON.parse(toolArgs)
										} catch {
											parsedargs = toolArgs
										}
									}
									toolcalls.set(toolCallId, {
										toolcallid: toolCallId,
										toolname: toolName || "unknown",
										args: parsedargs,
										state: "calling",
									})
									segments.push({ type: "tool", toolcallid: toolCallId })
									updatetoolcalls()
									updatesegments()
								}
								break
							}
							case "tool_call_update": {
								const { toolCallId, toolResult } = evt
								if (toolCallId && toolcalls.has(toolCallId)) {
									const existing = toolcalls.get(toolCallId)!
									const rawtext = typeof existing.result === "string" ? existing.result : ""
									existing.result = rawtext + (toolResult || "")
									existing.state = "streaming-args"
									updatetoolcalls()
								}
								break
							}
							case "tool_call_end": {
								const { toolCallId, toolResult, isToolError } = evt
								if (toolCallId) {
									if (toolcalls.has(toolCallId)) {
										const existing = toolcalls.get(toolCallId)!
										existing.result = toolResult
										existing.iserror = isToolError
										existing.state = isToolError ? "error" : "result"
									} else {
										toolcalls.set(toolCallId, {
											toolcallid: toolCallId,
											toolname: evt.toolName || "unknown",
											args: {},
											state: isToolError ? "error" : "result",
											result: toolResult,
											iserror: isToolError,
										})
										segments.push({ type: "tool", toolcallid: toolCallId })
										updatesegments()
									}
									updatetoolcalls()
								}
								break
							}
							case "file_output": {
								if (evt.artifacts && evt.artifacts.length > 0) {
									allartifacts.push(...evt.artifacts)
									setStreamingartifacts([...allartifacts])
									// Add a files segment to the chat stream
									segments.push({ type: "files", artifacts: [...evt.artifacts] })
									updatesegments()
								}
								break
							}
							case "thinking_update": {
								if (evt.text) {
									fullreasoning += evt.text
									setStreamingreasoning(fullreasoning)
								}
								break
							}
							case "error": {
								console.error("[chat] Stream error:", evt.error)
								toast.error(evt.error || "Agent encountered an error")
								break
							}
							case "turn_end": {
								ws.close()
								resolve()
								break
							}
						}
					}

					ws.onerror = () => {
						reject(new Error("WebSocket connection failed"))
					}

					ws.onclose = () => {
						resolve()
					}
				})

				// Build artifact attachments for DB persistence
				const artifactattachments = allartifacts.map((a) => ({
					type: "artifact" as const,
					filename: a.filename,
					mediatype: a.mediatype,
					url: `/api/conversations/${conversationid}/artifacts/${encodeURIComponent(a.filename)}`,
					sizebytes: a.sizebytes,
				}))

				try {
					await saveMessage({
						conversationid,
						payload: {
							sendertype: "agent",
							senderid: agentparticipant.participantid,
							content: fullcontent,
							metadata:
								toolcalls.size > 0
									? { toolcalls: Array.from(toolcalls.values()), segments }
									: segments.length > 0
										? { segments }
										: {},
							attachments: artifactattachments.length > 0 ? artifactattachments : undefined,
						},
					})
				} catch (err) {
					console.error("Failed to save agent message:", err)
				}

				// Refresh the conversation to get the persisted agent message
				queryClient.invalidateQueries({
					queryKey: [QUERY_KEYS.CONVERSATION, conversationid],
				})
			} catch (err) {
				console.error("Failed to stream from agent:", err)
				toast.error("Failed to get response from agent")
			}

			setStreaming(false)
			setStreamingcontent("")
			setStreamingtoolcalls([])
			setStreamingsegments([])
			setStreamingreasoning("")
			setStreamingartifacts([])
		},
		[conversationid, conversation, participants, queryClient, saveMessage, session],
	)

	return {
		streaming,
		streamingcontent,
		streamingtoolcalls,
		streamingsegments,
		streamingreasoning,
		streamingartifacts,
		handlesubmit,
	}
}

export default useChatStream
