/** Event types emitted by the agent during a turn. */
export type GatewayEventType =
	// Lifecycle
	| "turn_start"
	| "turn_end"
	// Assistant message streaming
	| "message_start"
	| "message_update"
	| "message_end"
	// Tool execution
	| "tool_call_start"
	| "tool_call_update"
	| "tool_call_end"
	// Thinking / reasoning
	| "thinking_update"
	// File output
	| "file_output"
	// Error
	| "error"

/** Metadata for a single artifact file produced by the agent. */
export interface FileArtifact {
	/** Filename in the artifacts directory. */
	filename: string
	/** MIME type (e.g. "text/html", "image/png"). */
	mediatype: string
	/** File size in bytes. */
	sizebytes: number
}

/** A single event in the agent response stream. */
export interface GatewayEvent {
	type: GatewayEventType
	/** Event or turn ID. */
	id?: string
	/** Text delta (for message_update / thinking_update). */
	text?: string
	/** Error message (for error events). */
	error?: string
	/** Tool name (for tool_call_* events). */
	toolName?: string
	/** Tool call ID (for tool_call_* events). */
	toolCallId?: string
	/** Tool arguments as JSON string (for tool_call_start). */
	toolArgs?: string
	/** Tool result text (for tool_call_end). */
	toolResult?: string
	/** Whether the tool execution errored (for tool_call_end). */
	isToolError?: boolean
	/** Artifacts detected after a tool call (for file_output events). */
	artifacts?: FileArtifact[]
}

/** Inbound WebSocket message from client. */
export type WsClientMessage =
	| {
			type: "message"
			sessionId: string
			content: string
			userId?: string
			/** File attachments as data URLs with metadata. */
			attachments?: WsAttachment[]
	  }
	| { type: "cancel"; sessionId: string }
	| { type: "ping" }

/** A file attachment included in a WebSocket message. */
export interface WsAttachment {
	/** Original filename. */
	filename: string
	/** MIME type (e.g. "image/png", "text/csv"). */
	mediaType: string
	/** File content as a data URL (data:mimetype;base64,...). */
	dataUrl: string
}

/** Outbound WebSocket message to client. */
export type WsServerMessage = GatewayEvent | { type: "pong" }

/** In-memory representation of a session. */
export interface Session {
	id: string
	/** Agent config this session was started with, if specified. */
	agentConfigId?: string
	createdAt: string
	messages: SessionMessage[]
}

/** A stored message within a session. */
export interface SessionMessage {
	id: string
	role: "user" | "assistant"
	content: string
	createdAt: string
}
