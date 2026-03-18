import type pg from "pg"
import type { User } from "../types.js"

export async function createUser(
	pool: pg.Pool,
	email: string,
	name?: string,
	role?: "admin" | "member",
	authProviderId?: string,
): Promise<User> {
	const result = await pool.query(
		`INSERT INTO users (email, name, role, auth_provider_id)
		 VALUES ($1, $2, $3, $4)
		 RETURNING *`,
		[email, name ?? null, role ?? "member", authProviderId ?? null],
	)
	return mapUser(result.rows[0])
}

export async function getUserById(pool: pg.Pool, id: string): Promise<User | null> {
	const result = await pool.query("SELECT * FROM users WHERE id = $1", [id])
	return result.rows[0] ? mapUser(result.rows[0]) : null
}

export async function getUserByEmail(pool: pg.Pool, email: string): Promise<User | null> {
	const result = await pool.query("SELECT * FROM users WHERE email = $1", [email])
	return result.rows[0] ? mapUser(result.rows[0]) : null
}

export async function listUsers(pool: pg.Pool): Promise<User[]> {
	const result = await pool.query("SELECT * FROM users ORDER BY created_at DESC")
	return result.rows.map(mapUser)
}

export async function updateUserRole(pool: pg.Pool, id: string, role: "admin" | "member"): Promise<void> {
	await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, id])
}

export async function deleteUser(pool: pg.Pool, id: string): Promise<void> {
	await pool.query("DELETE FROM users WHERE id = $1", [id])
}

export async function countUsers(pool: pg.Pool): Promise<number> {
	const result = await pool.query("SELECT COUNT(*)::int AS count FROM users")
	return result.rows[0].count
}

function mapUser(row: Record<string, unknown>): User {
	return {
		id: row.id as string,
		email: row.email as string,
		name: row.name as string | null,
		role: row.role as "admin" | "member",
		authProviderId: row.auth_provider_id as string | null,
		createdAt: row.created_at as Date,
	}
}
