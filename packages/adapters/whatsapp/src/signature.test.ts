import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { verifyWhatsAppSignature } from "./signature.js"

describe("verifyWhatsAppSignature", () => {
	it("accepts a valid sha256 signature", () => {
		const body = '{"object":"whatsapp_business_account"}'
		const secret = "test-secret"
		const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
		expect(verifyWhatsAppSignature(body, sig, secret)).toBe(true)
	})

	it("rejects a bad signature", () => {
		expect(verifyWhatsAppSignature("{}", "sha256=deadbeef", "test-secret")).toBe(false)
	})

	it("rejects missing header or secret", () => {
		expect(verifyWhatsAppSignature("{}", undefined, "x")).toBe(false)
		expect(verifyWhatsAppSignature("{}", "sha256=ab", "")).toBe(false)
	})
})
