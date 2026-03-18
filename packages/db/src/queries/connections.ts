import type pg from "pg"
import type { Connection, ConnectionType } from "../types.js"

export async function createConnection(
	pool: pg.Pool,
	config: {
		name: string
		type: ConnectionType
		encryptedCredentials: string
		readOnly?: boolean
		queryTimeout?: number
		rowLimit?: number
	},
): Promise<Connection> {
	const result = await pool.query(
		`INSERT INTO connections (name, type, encrypted_credentials, read_only, query_timeout, row_limit)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING *`,
		[
			config.name,
			config.type,
			config.encryptedCredentials,
			config.readOnly ?? true,
			config.queryTimeout ?? 30,
			config.rowLimit ?? 1000,
		],
	)
	return mapConnection(result.rows[0])
}

export async function getConnection(pool: pg.Pool, id: string): Promise<Connection | null> {
	const result = await pool.query("SELECT * FROM connections WHERE id = $1", [id])
	return result.rows[0] ? mapConnection(result.rows[0]) : null
}

export async function listConnections(pool: pg.Pool): Promise<Connection[]> {
	const result = await pool.query("SELECT * FROM connections ORDER BY created_at DESC")
	return result.rows.map(mapConnection)
}

export async function updateConnectionSchemaCache(
	pool: pg.Pool,
	id: string,
	schemaCache: unknown,
): Promise<void> {
	await pool.query("UPDATE connections SET schema_cache = $1, updated_at = now() WHERE id = $2", [
		JSON.stringify(schemaCache),
		id,
	])
}

export async function deleteConnection(pool: pg.Pool, id: string): Promise<void> {
	await pool.query("DELETE FROM connections WHERE id = $1", [id])
}

function mapConnection(row: Record<string, unknown>): Connection {
	return {
		id: row.id as string,
		name: row.name as string,
		type: row.type as ConnectionType,
		encryptedCredentials: row.encrypted_credentials as string,
		schemaCache: row.schema_cache,
		readOnly: row.read_only as boolean,
		queryTimeout: row.query_timeout as number,
		rowLimit: row.row_limit as number,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	}
}
