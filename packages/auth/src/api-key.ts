import { createHash, randomBytes } from "node:crypto"
import type pg from "pg"

/**
 * Generates a new API key and returns both the raw key (to show once) and the hash (to store).
 */
export function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
	const rawKey = `ozk_${randomBytes(32).toString("hex")}`
	const keyHash = hashApiKey(rawKey)
	const keyPrefix = rawKey.slice(0, 8)
	return { rawKey, keyHash, keyPrefix }
}

export function hashApiKey(rawKey: string): string {
	return createHash("sha256").update(rawKey).digest("hex")
}

export interface ApiKeyValidationResult {
	valid: boolean
	keyId: string | null
	scopes: string[]
}

export async function validateApiKey(pool: pg.Pool, rawKey: string): Promise<ApiKeyValidationResult> {
	const keyHash = hashApiKey(rawKey)
	const result = await pool.query("SELECT * FROM api_keys WHERE key_hash = $1", [keyHash])

	const row = result.rows[0]
	if (!row) {
		return { valid: false, keyId: null, scopes: [] }
	}

	if (row.expires_at && new Date(row.expires_at) < new Date()) {
		return { valid: false, keyId: null, scopes: [] }
	}

	// Update last_used_at (fire-and-forget)
	pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {})

	return {
		valid: true,
		keyId: row.id,
		scopes: row.scopes ?? [],
	}
}
