import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Verify Meta's X-Hub-Signature-256 header.
 * Header form: sha256=<hex>
 */
export const verifyWhatsAppSignature = (
	rawBody: string | Buffer,
	signatureHeader: string | undefined,
	appSecret: string,
): boolean => {
	if (!signatureHeader || !appSecret) return false
	const expected = `sha256=${createHmac("sha256", appSecret)
		.update(typeof rawBody === "string" ? rawBody : rawBody)
		.digest("hex")}`

	try {
		const a = Buffer.from(expected)
		const b = Buffer.from(signatureHeader)
		if (a.length !== b.length) return false
		return timingSafeEqual(a, b)
	} catch {
		return false
	}
}
