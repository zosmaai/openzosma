/**
 * Split a long reply into WhatsApp-safe chunks (4096 char hard limit).
 *
 * Prefer sentence boundaries, then whitespace, then a hard cut. Avoids
 * splitting mid-word when a space is available nearby.
 */
export const WHATSAPP_MAX_CHARS = 4096

export const splitMessage = (text: string, maxChars: number = WHATSAPP_MAX_CHARS): string[] => {
	const input = text ?? ""
	if (input.length === 0) return []
	if (input.length <= maxChars) return [input]

	const chunks: string[] = []
	let remaining = input

	while (remaining.length > maxChars) {
		const window = remaining.slice(0, maxChars)
		let cut = -1

		// Prefer the last sentence end in the window.
		for (const marker of [". ", "! ", "? ", ".\n", "!\n", "?\n", "\n\n"]) {
			const idx = window.lastIndexOf(marker)
			if (idx > maxChars * 0.4) {
				cut = Math.max(cut, idx + marker.length)
			}
		}

		// Fall back to last whitespace.
		if (cut <= 0) {
			const space = window.lastIndexOf(" ")
			const nl = window.lastIndexOf("\n")
			cut = Math.max(space, nl)
		}

		// Hard cut if there is no better break point.
		if (cut <= 0) {
			cut = maxChars
		}

		chunks.push(remaining.slice(0, cut).trimEnd())
		remaining = remaining.slice(cut).trimStart()
	}

	if (remaining.length > 0) {
		chunks.push(remaining)
	}

	return chunks
}
