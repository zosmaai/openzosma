import { runner } from "node-pg-migrate"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export async function runMigrations(direction: "up" | "down" = "up"): Promise<void> {
	await runner({
		databaseUrl: {
			host: process.env.DB_HOST ?? "localhost",
			port: parseInt(process.env.DB_PORT ?? "5432"),
			database: process.env.DB_NAME ?? "openzosma",
			user: process.env.DB_USER ?? "openzosma",
			password: process.env.DB_PASS ?? "openzosma",
		},
		dir: join(__dirname, "..", "migrations"),
		direction,
		migrationsTable: "pgmigrations",
		log: console.log,
	})
}

// CLI entrypoint
const direction = process.argv[2] === "down" ? "down" : "up"
runMigrations(direction)
	.then(() => {
		console.log(`Migrations ${direction} completed`)
		process.exit(0)
	})
	.catch((err: unknown) => {
		console.error(`Migration ${direction} failed:`, err)
		process.exit(1)
	})
