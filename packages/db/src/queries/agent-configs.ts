import type pg from "pg"
import type { AgentConfig } from "../types.js"

export async function createAgentConfig(
	pool: pg.Pool,
	config: {
		name: string
		model: string
		provider: string
		description?: string
		systemPrompt?: string
		toolsEnabled?: string[]
		skills?: string[]
		maxTokens?: number
		temperature?: number
	},
): Promise<AgentConfig> {
	const result = await pool.query(
		`INSERT INTO agent_configs (name, description, model, provider, system_prompt, tools_enabled, skills, max_tokens, temperature)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING *`,
		[
			config.name,
			config.description ?? null,
			config.model,
			config.provider,
			config.systemPrompt ?? null,
			JSON.stringify(config.toolsEnabled ?? []),
			JSON.stringify(config.skills ?? []),
			config.maxTokens ?? 4096,
			config.temperature ?? 0.7,
		],
	)
	return mapAgentConfig(result.rows[0])
}

export async function getAgentConfig(pool: pg.Pool, id: string): Promise<AgentConfig | null> {
	const result = await pool.query("SELECT * FROM agent_configs WHERE id = $1", [id])
	return result.rows[0] ? mapAgentConfig(result.rows[0]) : null
}

export async function listAgentConfigs(pool: pg.Pool): Promise<AgentConfig[]> {
	const result = await pool.query("SELECT * FROM agent_configs ORDER BY created_at DESC")
	return result.rows.map(mapAgentConfig)
}

export async function updateAgentConfig(
	pool: pg.Pool,
	id: string,
	updates: Partial<{
		name: string
		description: string | null
		model: string
		provider: string
		systemPrompt: string | null
		toolsEnabled: string[]
		skills: string[]
		maxTokens: number
		temperature: number
	}>,
): Promise<AgentConfig | null> {
	const fields: string[] = []
	const values: unknown[] = []
	let paramIndex = 1

	if (updates.name !== undefined) {
		fields.push(`name = $${paramIndex++}`)
		values.push(updates.name)
	}
	if (updates.description !== undefined) {
		fields.push(`description = $${paramIndex++}`)
		values.push(updates.description)
	}
	if (updates.model !== undefined) {
		fields.push(`model = $${paramIndex++}`)
		values.push(updates.model)
	}
	if (updates.provider !== undefined) {
		fields.push(`provider = $${paramIndex++}`)
		values.push(updates.provider)
	}
	if (updates.systemPrompt !== undefined) {
		fields.push(`system_prompt = $${paramIndex++}`)
		values.push(updates.systemPrompt)
	}
	if (updates.toolsEnabled !== undefined) {
		fields.push(`tools_enabled = $${paramIndex++}`)
		values.push(JSON.stringify(updates.toolsEnabled))
	}
	if (updates.skills !== undefined) {
		fields.push(`skills = $${paramIndex++}`)
		values.push(JSON.stringify(updates.skills))
	}
	if (updates.maxTokens !== undefined) {
		fields.push(`max_tokens = $${paramIndex++}`)
		values.push(updates.maxTokens)
	}
	if (updates.temperature !== undefined) {
		fields.push(`temperature = $${paramIndex++}`)
		values.push(updates.temperature)
	}

	if (fields.length === 0) return getAgentConfig(pool, id)

	fields.push("updated_at = now()")
	values.push(id)

	const result = await pool.query(
		`UPDATE agent_configs SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
		values,
	)
	return result.rows[0] ? mapAgentConfig(result.rows[0]) : null
}

export async function deleteAgentConfig(pool: pg.Pool, id: string): Promise<void> {
	await pool.query("DELETE FROM agent_configs WHERE id = $1", [id])
}

function mapAgentConfig(row: Record<string, unknown>): AgentConfig {
	return {
		id: row.id as string,
		name: row.name as string,
		description: row.description as string | null,
		model: row.model as string,
		provider: row.provider as string,
		systemPrompt: row.system_prompt as string | null,
		toolsEnabled: row.tools_enabled as string[],
		skills: row.skills as string[],
		maxTokens: row.max_tokens as number,
		temperature: row.temperature as number,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	}
}
