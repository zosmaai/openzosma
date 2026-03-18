import { betterAuth } from "better-auth"
import pg from "pg"

export interface AuthConfig {
	dbPool: pg.Pool
	secret: string
	baseUrl: string
	github?: {
		clientId: string
		clientSecret: string
	}
	google?: {
		clientId: string
		clientSecret: string
	}
	sessionExpiresIn?: number
	sessionUpdateAge?: number
}

export function createAuth(config: AuthConfig) {
	const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}

	if (config.github) {
		socialProviders.github = config.github
	}
	if (config.google) {
		socialProviders.google = config.google
	}

	return betterAuth({
		database: {
			type: "postgres",
			pool: config.dbPool,
		},
		baseURL: config.baseUrl,
		secret: config.secret,
		emailAndPassword: { enabled: true },
		socialProviders,
		session: {
			expiresIn: config.sessionExpiresIn ?? 60 * 60 * 24 * 7,
			updateAge: config.sessionUpdateAge ?? 60 * 60 * 24,
		},
	})
}

export function createAuthFromEnv(dbPool: pg.Pool) {
	return createAuth({
		dbPool,
		secret: process.env.AUTH_SECRET ?? "change-me-in-production",
		baseUrl: process.env.AUTH_URL ?? "http://localhost:3000",
		github:
			process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
				? {
						clientId: process.env.GITHUB_CLIENT_ID,
						clientSecret: process.env.GITHUB_CLIENT_SECRET,
					}
				: undefined,
		google:
			process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
				? {
						clientId: process.env.GOOGLE_CLIENT_ID,
						clientSecret: process.env.GOOGLE_CLIENT_SECRET,
					}
				: undefined,
	})
}
