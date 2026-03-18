import type pg from "pg"
import type { UsageRecord } from "../types.js"

export async function recordUsage(
	pool: pg.Pool,
	sessionId: string | null,
	tokensIn: number,
	tokensOut: number,
	model?: string,
	cost?: number,
): Promise<UsageRecord> {
	const result = await pool.query(
		`INSERT INTO usage (session_id, tokens_in, tokens_out, model, cost)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING *`,
		[sessionId, tokensIn, tokensOut, model ?? null, cost ?? 0],
	)
	return mapUsageRecord(result.rows[0])
}

export async function getUsageBySession(pool: pg.Pool, sessionId: string): Promise<UsageRecord[]> {
	const result = await pool.query("SELECT * FROM usage WHERE session_id = $1 ORDER BY created_at ASC", [sessionId])
	return result.rows.map(mapUsageRecord)
}

export interface UsageSummary {
	totalTokensIn: number
	totalTokensOut: number
	totalCost: number
	count: number
}

export async function getUsageSummary(pool: pg.Pool, since?: Date): Promise<UsageSummary> {
	const query = since
		? "SELECT COALESCE(SUM(tokens_in), 0)::int AS total_in, COALESCE(SUM(tokens_out), 0)::int AS total_out, COALESCE(SUM(cost), 0)::real AS total_cost, COUNT(*)::int AS count FROM usage WHERE created_at >= $1"
		: "SELECT COALESCE(SUM(tokens_in), 0)::int AS total_in, COALESCE(SUM(tokens_out), 0)::int AS total_out, COALESCE(SUM(cost), 0)::real AS total_cost, COUNT(*)::int AS count FROM usage"

	const result = await pool.query(query, since ? [since] : [])
	const row = result.rows[0]
	return {
		totalTokensIn: row.total_in,
		totalTokensOut: row.total_out,
		totalCost: row.total_cost,
		count: row.count,
	}
}

function mapUsageRecord(row: Record<string, unknown>): UsageRecord {
	return {
		id: row.id as string,
		sessionId: row.session_id as string | null,
		tokensIn: row.tokens_in as number,
		tokensOut: row.tokens_out as number,
		cost: row.cost as number,
		model: row.model as string | null,
		createdAt: row.created_at as Date,
	}
}
