/** Event types emitted by the agent during a turn. */
export type AgentEventType =
  | "turn_start"
  | "message_start"
  | "message_update"
  | "message_end"
  | "turn_end"
  | "error";

/** A single event in the agent response stream. */
export interface AgentEvent {
  type: AgentEventType;
  /** Event ID (UUID). */
  id?: string;
  /** Text content (for message_update). */
  text?: string;
  /** Error message (for error events). */
  error?: string;
}

/** Inbound WebSocket message from client. */
export type WsClientMessage =
  | { type: "message"; sessionId: string; content: string }
  | { type: "cancel"; sessionId: string }
  | { type: "ping" };

/** Outbound WebSocket message to client. */
export type WsServerMessage = AgentEvent | { type: "pong" };

/** In-memory representation of a session. */
export interface Session {
  id: string;
  createdAt: string;
  messages: SessionMessage[];
}

/** A stored message within a session. */
export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
