import { createLogger } from "@openzosma/logger"

const log = createLogger({ component: "whatsapp-adapter" })

export interface GraphClientConfig {
	accessToken: string
	apiVersion: string
	fetchImpl?: typeof fetch
}

export class WhatsAppGraphClient {
	private readonly accessToken: string
	private readonly apiVersion: string
	private readonly fetchImpl: typeof fetch

	constructor(config: GraphClientConfig) {
		this.accessToken = config.accessToken
		this.apiVersion = config.apiVersion
		this.fetchImpl = config.fetchImpl ?? fetch
	}

	async sendText(phoneNumberId: string, to: string, body: string): Promise<void> {
		const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/messages`
		const res = await this.fetchImpl(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to,
				type: "text",
				text: { body, preview_url: false },
			}),
		})
		if (!res.ok) {
			const errText = await res.text().catch(() => "")
			log.error("WhatsApp sendText failed", {
				status: res.status,
				body: errText.slice(0, 500),
				phoneNumberId,
				to,
			})
			throw new Error(`WhatsApp sendText failed: HTTP ${res.status}`)
		}
	}

	/**
	 * Resolve a media id to a temporary download URL then fetch bytes.
	 * Callers may attach a short caption note when binary handling is limited.
	 */
	async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType?: string }> {
		const metaUrl = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`
		const metaRes = await this.fetchImpl(metaUrl, {
			headers: { Authorization: `Bearer ${this.accessToken}` },
		})
		if (!metaRes.ok) {
			throw new Error(`WhatsApp media meta failed: HTTP ${metaRes.status}`)
		}
		const meta = (await metaRes.json()) as { url?: string; mime_type?: string }
		if (!meta.url) {
			throw new Error("WhatsApp media meta missing url")
		}
		const binRes = await this.fetchImpl(meta.url, {
			headers: { Authorization: `Bearer ${this.accessToken}` },
		})
		if (!binRes.ok) {
			throw new Error(`WhatsApp media download failed: HTTP ${binRes.status}`)
		}
		const ab = await binRes.arrayBuffer()
		return { buffer: Buffer.from(ab), mimeType: meta.mime_type }
	}
}
