import type { WhatsAppInboundMessage, WhatsAppWebhookMetadata } from "./types.js"

/** Pull inbound user messages out of a Meta Cloud API webhook body. */
export const parseWebhookMessages = (
	body: unknown,
): Array<{ metadata: WhatsAppWebhookMetadata; message: WhatsAppInboundMessage }> => {
	const out: Array<{ metadata: WhatsAppWebhookMetadata; message: WhatsAppInboundMessage }> = []
	if (!body || typeof body !== "object") return out

	const root = body as {
		entry?: Array<{
			changes?: Array<{
				field?: string
				value?: {
					metadata?: { phone_number_id?: string; display_phone_number?: string }
					messages?: Array<Record<string, unknown>>
				}
			}>
		}>
	}

	for (const entry of root.entry ?? []) {
		for (const change of entry.changes ?? []) {
			if (change.field && change.field !== "messages") continue
			const value = change.value
			if (!value?.messages?.length) continue
			const metadata: WhatsAppWebhookMetadata = {
				phoneNumberId: value.metadata?.phone_number_id ?? "",
				displayPhoneNumber: value.metadata?.display_phone_number,
			}
			for (const raw of value.messages) {
				const parsed = parseInboundMessage(raw)
				if (parsed) out.push({ metadata, message: parsed })
			}
		}
	}
	return out
}

export const parseInboundMessage = (raw: Record<string, unknown>): WhatsAppInboundMessage | null => {
	const id = String(raw.id ?? "")
	const from = String(raw.from ?? "")
	const timestamp = String(raw.timestamp ?? "")
	const type = String(raw.type ?? "unknown")
	if (!id || !from) return null

	if (type === "text") {
		const text = (raw.text as { body?: string } | undefined)?.body ?? ""
		return { id, from, timestamp, type: "text", text }
	}

	if (type === "image" || type === "document" || type === "audio") {
		const media = raw[type] as
			| { id?: string; caption?: string; mime_type?: string; filename?: string }
			| undefined
		return {
			id,
			from,
			timestamp,
			type,
			mediaId: media?.id,
			caption: media?.caption,
			mimeType: media?.mime_type,
			filename: media?.filename,
			text: media?.caption,
		}
	}

	return { id, from, timestamp, type: "unknown", text: `[unsupported message type: ${type}]` }
}
