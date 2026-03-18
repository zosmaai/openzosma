import type pg from "pg"
import type { ApiKey } from "../types.js"

export async function createApiKey(
	pool: pg.Pool,
	name: string,
	keyHash: string,
	keyPrefix: string,
	scopes?: string[],
	expiresAt?: Date,
): Promise<ApiKey> {
	const result = await pool.query(
		`INSERT INTO api_keys (name, key_hash, key_prefix, scopes, expires_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING *`,
		[name, keyHash, keyPrefix, JSON.stringify(scopes ?? ["sessions:read", "sessions:write"]), expiresAt ?? null],
	)
	return mapApiKey(result.rows[0])
}

export async function getApiKeyByHash(pool: pg.Pool, keyHash: string): Promise<ApiKey | null> {
	const result = await pool.query("SELECT * FROM api_keys WHERE key_hash = $1", [keyHash])
	return result.rows[0] ? mapApiKey(result.rows[0]) : null
}

export async function listApiKeys(pool: pg.Pool): Promise<ApiKey[]> {
	const result = await pool.query("SELECT * FROM api_keys ORDER BY created_at DESC")
	return result.rows.map(mapApiKey)
}

export async function updateApiKeyLastUsed(pool: pg.Pool, id: string): Promise<void> {
	await pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id])
}

export async function deleteApiKey(pool: pg.Pool, id: string): Promise<void> {
	await pool.query("DELETE FROM api_keys WHERE id = $1", [id])
}

function mapApiKey(row: Record<string, unknown>): ApiKey {
	return {
		id: row.id as string,
		name: row.name as string,
		keyHash: row.key_hash as string,
		keyPrefix: row.key_prefix as string,
		scopes: row.scopes as string[],
		lastUsedAt: row.last_used_at as Date | null,
		expiresAt: row.expires_at as Date | null,
		createdAt: row.created_at as Date,
	}
}
