/**
 * Minimal type contracts for the WhatsApp adapter.
 * Duplicated from gateway to avoid a circular workspace dependency.
 */

export interface ChannelAdapter {
	readonly name: string
	init(sessionManager: AdapterSessionManager): Promise<void>
	shutdown(): Promise<void>
}

export interface AdapterSessionManager {
	createSession(
		id?: string,
		agentConfigId?: string,
		resolvedConfig?: {
			provider?: string
			model?: string
			systemPrompt?: string | null
			systemPromptPrefix?: string
			toolsEnabled?: string[]
		},
		userId?: string,
	): Promise<{ id: string }>
	sendMessage(
		sessionId: string,
		content: string,
		signal?: AbortSignal,
		userId?: string,
	): AsyncGenerator<AdapterGatewayEvent> | AsyncIterable<AdapterGatewayEvent>
	resolveUserByEmail?(email: string): Promise<string | null>
}

export interface AdapterGatewayEvent {
	type: string
	text?: string
	error?: string
}

export interface WhatsAppAdapterConfig {
	/** Permanent Meta system user / WhatsApp token. */
	accessToken: string
	/** Token Meta sends on GET webhook verification. */
	verifyToken: string
	/** Optional app secret for X-Hub-Signature-256 checks. */
	appSecret?: string
	/** Default phone_number_id when not present on the webhook payload. */
	phoneNumberId?: string
	/** Graph API version, default v21.0. */
	apiVersion?: string
}

export type WhatsAppInboundType = "text" | "image" | "document" | "audio" | "unknown"

export interface WhatsAppInboundMessage {
	id: string
	from: string
	timestamp: string
	type: WhatsAppInboundType
	text?: string
	mediaId?: string
	caption?: string
	mimeType?: string
	filename?: string
}

export interface WhatsAppWebhookMetadata {
	phoneNumberId: string
	displayPhoneNumber?: string
}
