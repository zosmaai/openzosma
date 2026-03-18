import type pg from "pg"
import type { Setting } from "../types.js"

export async function getSetting(pool: pg.Pool, key: string): Promise<Setting | null> {
	const result = await pool.query("SELECT * FROM settings WHERE key = $1", [key])
	return result.rows[0] ? mapSetting(result.rows[0]) : null
}

export async function getSettingValue<T = unknown>(pool: pg.Pool, key: string): Promise<T | null> {
	const setting = await getSetting(pool, key)
	return setting ? (setting.value as T) : null
}

export async function upsertSetting(pool: pg.Pool, key: string, value: unknown): Promise<Setting> {
	const result = await pool.query(
		`INSERT INTO settings (key, value, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
		 RETURNING *`,
		[key, JSON.stringify(value)],
	)
	return mapSetting(result.rows[0])
}

export async function listSettings(pool: pg.Pool): Promise<Setting[]> {
	const result = await pool.query("SELECT * FROM settings ORDER BY key")
	return result.rows.map(mapSetting)
}

export async function deleteSetting(pool: pg.Pool, key: string): Promise<void> {
	await pool.query("DELETE FROM settings WHERE key = $1", [key])
}

function mapSetting(row: Record<string, unknown>): Setting {
	return {
		key: row.key as string,
		value: row.value,
		updatedAt: row.updated_at as Date,
	}
}
