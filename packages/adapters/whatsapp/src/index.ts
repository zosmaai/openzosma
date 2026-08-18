import { createLogger } from "@openzosma/logger"
import { WhatsAppGraphClient } from "./client.js"
import { parseWebhookMessages } from "./parse.js"
import { verifyWhatsAppSignature } from "./signature.js"
import { WHATSAPP_MAX_CHARS, splitMessage } from "./split-message.js"
import type {
	AdapterGatewayEvent,
	AdapterSessionManager,
	ChannelAdapter,
	WhatsAppAdapterConfig,
	WhatsAppInboundMessage,
	WhatsAppWebhookMetadata,
} from "./types.js"

export type { WhatsAppAdapterConfig, ChannelAdapter } from "./types.js"
export { splitMessage, WHATSAPP_MAX_CHARS } from "./split-message.js"
export { verifyWhatsAppSignature } from "./signature.js"
export { parseWebhookMessages, parseInboundMessage } from "./parse.js"

const log = createLogger({ component: "whatsapp-adapter" })

const SESSION_TTL_MS = 24 * 60 * 60 * 1000

interface SessionEntry {
	sessionId: string
	expiresAt: number
}

/**
 * WhatsApp Business Cloud API channel adapter.
 *
 * Exposes Meta webhook verify + inbound handlers. The gateway mounts:
 *   GET  /webhooks/whatsapp
 *   POST /webhooks/whatsapp
 *
 * Maps phone conversations to orchestrator sessions and sends complete
 * replies (WhatsApp cannot edit messages). Long replies are split at
 * sentence boundaries under the 4096 character limit.
 */
export class WhatsAppAdapter implements ChannelAdapter {
	readonly name = "whatsapp"

	private readonly config: Required<
		Pick<WhatsAppAdapterConfig, "accessToken" | "verifyToken" | "apiVersion">
	> &
		WhatsAppAdapterConfig
	private sessionManager: AdapterSessionManager | undefined
	private readonly client: WhatsAppGraphClient
	private readonly sessions = new Map<string, SessionEntry>()
	/** Serialize turns per conversation key. */
	private readonly active = new Set<string>()
	private readonly queues = new Map<string, Array<() => Promise<void>>>()

	constructor(config: WhatsAppAdapterConfig, fetchImpl?: typeof fetch) {
		if (!config.accessToken) throw new Error("WhatsApp accessToken is required")
		if (!config.verifyToken) throw new Error("WhatsApp verifyToken is required")
		this.config = {
			...config,
			apiVersion: config.apiVersion ?? "v21.0",
		}
		this.client = new WhatsAppGraphClient({
			accessToken: this.config.accessToken,
			apiVersion: this.config.apiVersion,
			fetchImpl,
		})
	}

	async init(sessionManager: AdapterSessionManager): Promise<void> {
		this.sessionManager = sessionManager
		log.info("WhatsApp adapter ready (waiting for webhooks)")
	}

	async shutdown(): Promise<void> {
		this.sessions.clear()
		this.queues.clear()
		this.active.clear()
	}

	/** Meta webhook verification handshake. */
	handleVerify(query: {
		"hub.mode"?: string
		"hub.verify_token"?: string
		"hub.challenge"?: string
	}): { status: number; body: string } {
		const mode = query["hub.mode"]
		const token = query["hub.verify_token"]
		const challenge = query["hub.challenge"]
		if (mode === "subscribe" && token === this.config.verifyToken && challenge) {
			return { status: 200, body: challenge }
		}
		return { status: 403, body: "Forbidden" }
	}

	/**
	 * Handle an inbound webhook POST.
	 * @param rawBody original body string used for signature checks
	 */
	async handleWebhook(
		rawBody: string,
		signatureHeader: string | undefined,
	): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
		if (this.config.appSecret) {
			const ok = verifyWhatsAppSignature(rawBody, signatureHeader, this.config.appSecret)
			if (!ok) {
				log.warn("WhatsApp webhook signature check failed")
				return { status: 401, body: { error: "Invalid signature" } }
			}
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(rawBody)
		} catch {
			return { status: 400, body: { error: "Invalid JSON" } }
		}

		const items = parseWebhookMessages(parsed)
		// Ack quickly; process messages without blocking Meta's retry window too long.
		// We still await processing so errors are logged before the response returns.
		for (const item of items) {
			const phoneNumberId =
				item.metadata.phoneNumberId || this.config.phoneNumberId || ""
			if (!phoneNumberId) {
				log.warn("WhatsApp message missing phone_number_id")
				continue
			}
			await this.enqueueMessage({ ...item.metadata, phoneNumberId }, item.message)
		}

		return { status: 200, body: { ok: true } }
	}

	private conversationKey(phoneNumberId: string, userPhone: string): string {
		return `whatsapp:${phoneNumberId}:${userPhone}`
	}

	private async enqueueMessage(
		metadata: WhatsAppWebhookMetadata,
		message: WhatsAppInboundMessage,
	): Promise<void> {
		const key = this.conversationKey(metadata.phoneNumberId, message.from)
		const job = async () => {
			try {
				await this.processMessage(metadata, message)
			} catch (err) {
				log.error("WhatsApp message handling failed", {
					from: message.from,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		const queue = this.queues.get(key) ?? []
		queue.push(job)
		this.queues.set(key, queue)
		if (this.active.has(key)) return

		this.active.add(key)
		try {
			while (true) {
				const next = this.queues.get(key)?.shift()
				if (!next) break
				await next()
			}
		} finally {
			this.active.delete(key)
			if ((this.queues.get(key)?.length ?? 0) === 0) {
				this.queues.delete(key)
			}
		}
	}

	private async getOrCreateSession(phoneNumberId: string, userPhone: string): Promise<string> {
		if (!this.sessionManager) {
			throw new Error("WhatsApp adapter not initialized")
		}
		const key = this.conversationKey(phoneNumberId, userPhone)
		const now = Date.now()
		const existing = this.sessions.get(key)
		if (existing && existing.expiresAt > now) {
			existing.expiresAt = now + SESSION_TTL_MS
			return existing.sessionId
		}

		const session = await this.sessionManager.createSession(
			undefined,
			undefined,
			{
				systemPromptPrefix:
					"<role>You are communicating with a user through WhatsApp. Keep replies concise and plain. Avoid heavy markdown that WhatsApp will not render.</role>",
			},
			undefined,
		)
		this.sessions.set(key, { sessionId: session.id, expiresAt: now + SESSION_TTL_MS })
		return session.id
	}

	private async processMessage(
		metadata: WhatsAppWebhookMetadata,
		message: WhatsAppInboundMessage,
	): Promise<void> {
		const sessionId = await this.getOrCreateSession(metadata.phoneNumberId, message.from)
		const content = await this.toUserContent(message)
		if (!content.trim()) {
			log.info("Skipping empty WhatsApp message", { id: message.id })
			return
		}

		let responseText = ""
		const events = this.sessionManager!.sendMessage(sessionId, content)
		for await (const event of events as AsyncIterable<AdapterGatewayEvent>) {
			if (event.type === "message_update" && event.text) {
				responseText += event.text
			} else if (event.type === "error" && event.error) {
				responseText += `\n[error] ${event.error}`
			}
		}

		const chunks = splitMessage(responseText.trim() || "Sorry, I could not produce a reply.", WHATSAPP_MAX_CHARS)
		for (const chunk of chunks) {
			await this.client.sendText(metadata.phoneNumberId, message.from, chunk)
		}
	}

	private async toUserContent(message: WhatsAppInboundMessage): Promise<string> {
		if (message.type === "text") {
			return message.text ?? ""
		}

		if (message.type === "image" || message.type === "document" || message.type === "audio") {
			const caption = message.caption?.trim() ?? ""
			const label = message.type
			const name = message.filename ? ` (${message.filename})` : ""
			// Media bytes are downloaded when possible so future attachment
			// wiring can reuse them; for now surface a clear text placeholder.
			if (message.mediaId) {
				try {
					const media = await this.client.downloadMedia(message.mediaId)
					const sizeKb = Math.round(media.buffer.length / 1024)
					const parts = [
						`[WhatsApp ${label}${name}, ${sizeKb} KB${media.mimeType ? `, ${media.mimeType}` : ""}]`,
					]
					if (caption) parts.push(caption)
					return parts.join("\n")
				} catch (err) {
					log.warn("WhatsApp media download failed", {
						mediaId: message.mediaId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			return caption || `[WhatsApp ${label}${name}]`
		}

		return message.text ?? ""
	}
}
