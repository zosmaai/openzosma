import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AgentProvider, AgentSession } from "@openzosma/agents"
import { PiAgentProvider } from "@openzosma/agents"
import type { GatewayEvent, Session, SessionMessage } from "./types.js"

/**
 * Per-session state holding the agent session and gateway-level metadata.
 */
interface SessionState {
	agentSession: AgentSession
	session: Session
}

export class SessionManager {
	private sessions = new Map<string, SessionState>()
	private provider: AgentProvider

	constructor(provider?: AgentProvider) {
		this.provider = provider ?? new PiAgentProvider()
	}

	createSession(): Session {
		const session: Session = {
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			messages: [],
		}

		const workspaceRoot = resolve(process.env.OPENZOSMA_WORKSPACE ?? join(process.cwd(), "workspace"))
		const sessionDir = join(workspaceRoot, "sessions", session.id)
		mkdirSync(sessionDir, { recursive: true })

		const agentSession = this.provider.createSession({
			sessionId: session.id,
			workspaceDir: sessionDir,
		})

		this.sessions.set(session.id, { agentSession, session })
		return session
	}

	getSession(id: string): Session | undefined {
		return this.sessions.get(id)?.session
	}

	/**
	 * Send a user message and stream back gateway events.
	 *
	 * Delegates to the configured AgentProvider's session, mapping
	 * AgentStreamEvents to GatewayEvents.
	 */
	async *sendMessage(sessionId: string, content: string, signal?: AbortSignal): AsyncGenerator<GatewayEvent> {
		const state = this.sessions.get(sessionId)
		if (!state) {
			yield { type: "error", error: `Session ${sessionId} not found` }
			return
		}

		const { agentSession, session } = state

		// Store user message
		const userMsg: SessionMessage = {
			id: randomUUID(),
			role: "user",
			content,
			createdAt: new Date().toISOString(),
		}
		session.messages.push(userMsg)

		let lastAssistantText = ""
		let lastMessageId: string | undefined

		for await (const event of agentSession.sendMessage(content, signal)) {
			// AgentStreamEvent and GatewayEvent have the same shape --
			// pass through directly, tracking text for session history.
			const gatewayEvent: GatewayEvent = event as GatewayEvent

			if (event.type === "message_start") {
				lastMessageId = event.id
				lastAssistantText = ""
			} else if (event.type === "message_update" && event.text) {
				lastAssistantText += event.text
			}

			yield gatewayEvent
		}

		// Store assistant message for session history
		if (lastAssistantText) {
			const assistantMsg: SessionMessage = {
				id: lastMessageId ?? randomUUID(),
				role: "assistant",
				content: lastAssistantText,
				createdAt: new Date().toISOString(),
			}
			session.messages.push(assistantMsg)
		}
	}
}
