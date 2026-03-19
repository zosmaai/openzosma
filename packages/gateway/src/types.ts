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
	// Error
	| "error"

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
}

/** Inbound WebSocket message from client. */
export type WsClientMessage =
	| { type: "message"; sessionId: string; content: string }
	| { type: "cancel"; sessionId: string }
	| { type: "ping" }

/** Outbound WebSocket message to client. */
export type WsServerMessage = GatewayEvent | { type: "pong" }

/** In-memory representation of a session. */
export interface Session {
	id: string
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
