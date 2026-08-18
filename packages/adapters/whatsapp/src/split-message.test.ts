import { describe, expect, it } from "vitest"
import { WHATSAPP_MAX_CHARS, splitMessage } from "./split-message.js"

describe("splitMessage", () => {
	it("returns empty for empty input", () => {
		expect(splitMessage("")).toEqual([])
	})

	it("returns a single chunk when under the limit", () => {
		expect(splitMessage("hello")).toEqual(["hello"])
	})

	it("splits on sentence boundaries before the hard limit", () => {
		const sentence = "This is a full sentence. "
		const text = sentence.repeat(300) // well over 4096
		const chunks = splitMessage(text, WHATSAPP_MAX_CHARS)
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_MAX_CHARS)
		}
		// Prefer ending on a sentence when possible.
		expect(chunks[0]?.endsWith(".") || chunks[0]?.endsWith(" ")).toBe(true)
	})

	it("does not split mid-word when a space is available", () => {
		const word = "word"
		const text = `${"x".repeat(100)} ${word.repeat(2000)}`
		const chunks = splitMessage(text, 200)
		expect(chunks.length).toBeGreaterThan(1)
		// No chunk should start with a partial pattern of "ord" alone from a broken "word".
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(200)
		}
	})

	it("hard-cuts when there is no whitespace", () => {
		const text = "a".repeat(5000)
		const chunks = splitMessage(text, 1000)
		expect(chunks.length).toBe(5)
		expect(chunks.every((c) => c.length <= 1000)).toBe(true)
		expect(chunks.join("")).toBe(text)
	})
})
