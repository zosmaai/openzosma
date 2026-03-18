import pg from "pg"

export interface PoolConfig {
	host?: string
	port?: number
	database?: string
	user?: string
	password?: string
	max?: number
}

export function createPool(config?: PoolConfig): pg.Pool {
	return new pg.Pool({
		host: config?.host ?? process.env.DB_HOST ?? "localhost",
		port: config?.port ?? parseInt(process.env.DB_PORT ?? "5432"),
		database: config?.database ?? process.env.DB_NAME ?? "openzosma",
		user: config?.user ?? process.env.DB_USER ?? "openzosma",
		password: config?.password ?? process.env.DB_PASS ?? "openzosma",
		max: config?.max ?? parseInt(process.env.DB_POOL_SIZE ?? "20"),
	})
}
