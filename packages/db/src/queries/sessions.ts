import type pg from "pg"
import type { Session, SessionStatus } from "../types.js"

export async function createSession(
	pool: pg.Pool,
	userId: string,
	agentConfigId?: string,
	metadata?: Record<string, unknown>,
): Promise<Session> {
	const result = await pool.query(
		`INSERT INTO sessions (user_id, agent_config_id, metadata)
		 VALUES ($1, $2, $3)
		 RETURNING *`,
		[userId, agentConfigId ?? null, JSON.stringify(metadata ?? {})],
	)
	return mapSession(result.rows[0])
}

export async function getSession(pool: pg.Pool, id: string): Promise<Session | null> {
	const result = await pool.query("SELECT * FROM sessions WHERE id = $1", [id])
	return result.rows[0] ? mapSession(result.rows[0]) : null
}

export async function updateSessionStatus(pool: pg.Pool, id: string, status: SessionStatus): Promise<void> {
	const endedClause = status === "ended" || status === "failed" ? ", ended_at = now()" : ""
	await pool.query(`UPDATE sessions SET status = $1${endedClause} WHERE id = $2`, [status, id])
}

export async function updateSessionSandbox(pool: pg.Pool, id: string, sandboxId: string): Promise<void> {
	await pool.query("UPDATE sessions SET sandbox_id = $1 WHERE id = $2", [sandboxId, id])
}

export async function getActiveSessions(pool: pg.Pool): Promise<Session[]> {
	const result = await pool.query(
		"SELECT * FROM sessions WHERE status IN ('created', 'active') ORDER BY created_at DESC",
	)
	return result.rows.map(mapSession)
}

export async function getSessionsByUser(pool: pg.Pool, userId: string, limit = 50, offset = 0): Promise<Session[]> {
	const result = await pool.query(
		"SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
		[userId, limit, offset],
	)
	return result.rows.map(mapSession)
}

export async function deleteSession(pool: pg.Pool, id: string): Promise<void> {
	await pool.query("DELETE FROM sessions WHERE id = $1", [id])
}

function mapSession(row: Record<string, unknown>): Session {
	return {
		id: row.id as string,
		userId: row.user_id as string,
		agentConfigId: row.agent_config_id as string | null,
		sandboxId: row.sandbox_id as string | null,
		status: row.status as SessionStatus,
		metadata: (row.metadata as Record<string, unknown>) ?? {},
		createdAt: row.created_at as Date,
		endedAt: row.ended_at as Date | null,
	}
}
