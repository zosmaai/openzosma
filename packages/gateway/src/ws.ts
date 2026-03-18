import type { WebSocket } from "ws"
import type { SessionManager } from "./session-manager.js"
import type { WsClientMessage, WsServerMessage } from "./types.js"

/** Active turn abort controllers, keyed by sessionId. */
const activeTurns = new Map<string, AbortController>()

function send(ws: WebSocket, msg: WsServerMessage): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(msg))
	}
}

export function handleWebSocket(ws: WebSocket, sessionManager: SessionManager): void {
	ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
		let msg: WsClientMessage
		try {
			msg = JSON.parse(String(raw)) as WsClientMessage
		} catch {
			send(ws, { type: "error", error: "Invalid JSON" })
			return
		}

		if (msg.type === "ping") {
			send(ws, { type: "pong" })
			return
		}

		if (msg.type === "cancel") {
			const controller = activeTurns.get(msg.sessionId)
			if (controller) {
				controller.abort()
				activeTurns.delete(msg.sessionId)
			}
			return
		}

		if (msg.type === "message") {
			// Cancel any existing turn for this session
			const existing = activeTurns.get(msg.sessionId)
			if (existing) {
				existing.abort()
			}

			const controller = new AbortController()
			activeTurns.set(msg.sessionId, controller)

			void streamResponse(ws, sessionManager, msg.sessionId, msg.content, controller)
			return
		}

		send(ws, { type: "error", error: "Unknown message type" })
	})

	ws.on("close", () => {
		// Clean up any active turns — we don't know which session this socket
		// was driving, so iterate all. In practice there's typically one.
		for (const [key, controller] of activeTurns) {
			controller.abort()
			activeTurns.delete(key)
		}
	})
}

async function streamResponse(
	ws: WebSocket,
	sessionManager: SessionManager,
	sessionId: string,
	content: string,
	controller: AbortController,
): Promise<void> {
	try {
		for await (const event of sessionManager.sendMessage(sessionId, content, controller.signal)) {
			send(ws, event)
		}
	} finally {
		activeTurns.delete(sessionId)
	}
}
