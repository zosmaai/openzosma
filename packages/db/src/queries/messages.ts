import type pg from "pg"
import type { Message, MessageRole } from "../types.js"

export async function createMessage(
	pool: pg.Pool,
	sessionId: string,
	role: MessageRole,
	content?: string,
	toolCalls?: unknown[],
	toolResults?: unknown[],
	tokensIn?: number,
	tokensOut?: number,
): Promise<Message> {
	const result = await pool.query(
		`INSERT INTO messages (session_id, role, content, tool_calls, tool_results, tokens_in, tokens_out)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING *`,
		[
			sessionId,
			role,
			content ?? null,
			toolCalls ? JSON.stringify(toolCalls) : null,
			toolResults ? JSON.stringify(toolResults) : null,
			tokensIn ?? 0,
			tokensOut ?? 0,
		],
	)
	return mapMessage(result.rows[0])
}

export async function getMessagesBySession(
	pool: pg.Pool,
	sessionId: string,
	limit = 100,
	offset = 0,
): Promise<Message[]> {
	const result = await pool.query(
		"SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
		[sessionId, limit, offset],
	)
	return result.rows.map(mapMessage)
}

export async function getMessageById(pool: pg.Pool, id: string): Promise<Message | null> {
	const result = await pool.query("SELECT * FROM messages WHERE id = $1", [id])
	return result.rows[0] ? mapMessage(result.rows[0]) : null
}

export async function countMessagesBySession(pool: pg.Pool, sessionId: string): Promise<number> {
	const result = await pool.query("SELECT COUNT(*)::int AS count FROM messages WHERE session_id = $1", [sessionId])
	return result.rows[0].count
}

function mapMessage(row: Record<string, unknown>): Message {
	return {
		id: row.id as string,
		sessionId: row.session_id as string,
		role: row.role as MessageRole,
		content: row.content as string | null,
		toolCalls: row.tool_calls as unknown[] | null,
		toolResults: row.tool_results as unknown[] | null,
		tokensIn: row.tokens_in as number,
		tokensOut: row.tokens_out as number,
		createdAt: row.created_at as Date,
	}
}
