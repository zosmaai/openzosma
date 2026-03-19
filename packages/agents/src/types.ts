/** Event types emitted by an agent during a turn. */
export type AgentStreamEventType =
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
export interface AgentStreamEvent {
	type: AgentStreamEventType
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

/** A stored message within an agent session. */
export interface AgentMessage {
	id: string
	role: "user" | "assistant"
	content: string
	createdAt: string
}

/** Options for creating an agent session. */
export interface AgentSessionOpts {
	sessionId: string
	workspaceDir: string
}

/** A single agent session that can exchange messages. */
export interface AgentSession {
	/** Send a user message and stream back events. */
	sendMessage(content: string, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent>
	/** Get all messages in this session. */
	getMessages(): AgentMessage[]
}

/** Provider that creates agent sessions. */
export interface AgentProvider {
	/** Unique identifier for this provider (e.g. "pi-coding"). */
	readonly id: string
	/** Human-readable name (e.g. "Pi Coding Agent"). */
	readonly name: string
	/** Create a new session backed by this provider. */
	createSession(opts: AgentSessionOpts): AgentSession
}
