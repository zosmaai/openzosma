import "dotenv/config"
import { serve } from "@hono/node-server"
import { createAuthFromEnv } from "@openzosma/auth"
import { createPool } from "@openzosma/db"
import { createLogger } from "@openzosma/logger"
import type { OrchestratorSessionManager } from "@openzosma/orchestrator"
import { WebSocketServer } from "ws"
import { initAdapters } from "./adapters.js"
import { createApp } from "./app.js"
import { SessionManager } from "./session-manager.js"
import { handleWebSocket } from "./ws.js"

const log = createLogger({ component: "gateway" })

const PORT = Number(process.env.GATEWAY_PORT) || 4000
const HOST = process.env.GATEWAY_HOST || "0.0.0.0"
const SANDBOX_MODE = process.env.OPENZOSMA_SANDBOX_MODE || "local"

// Pool is optional in local mode: when DATABASE_URL / DB_* vars are not set
// (e.g. bare MVP dev without Postgres) the gateway still starts and A2A routes
// return empty skills. In orchestrator mode the pool is required.
const pool = (process.env.DATABASE_URL ?? process.env.DB_HOST) ? createPool() : undefined

/** Orchestrator reference, set when SANDBOX_MODE=orchestrator. */
let orchestrator: OrchestratorSessionManager | undefined

const createSessionManager = async (): Promise<SessionManager> => {
	if (SANDBOX_MODE === "orchestrator") {
		if (!pool) {
			throw new Error(
				"OPENZOSMA_SANDBOX_MODE=orchestrator requires a database connection. " +
					"Set DATABASE_URL or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS.",
			)
		}

		const { SandboxManager, OrchestratorSessionManager, loadConfigFromEnv, startHealthCheckLoop } = await import(
			"@openzosma/orchestrator"
		)
		const config = loadConfigFromEnv()

		const sandboxManager = new SandboxManager(pool, { config })
		orchestrator = new OrchestratorSessionManager(pool, sandboxManager)

		log.info("Sandbox mode: orchestrator (per-user OpenShell sandboxes)")

		// Start background health check loop to detect dead sandboxes
		// and suspend idle ones
		startHealthCheckLoop(sandboxManager, config.healthCheckIntervalMs ?? 60_000, {
			onHealthCheckComplete: (unhealthy) => {
				log.warn("Unhealthy sandboxes detected", { count: unhealthy.length, sandboxes: unhealthy })
			},
			onIdleSuspended: (suspended) => {
				log.info("Idle sandboxes suspended", { count: suspended.length, users: suspended })
			},
			onError: (err) => {
				const msg = err instanceof Error ? err.message : String(err)
				log.error("Health check loop error", { error: msg })
			},
		})

		return new SessionManager({ pool, orchestrator })
	}

	log.info("Sandbox mode: local (in-process pi-agent)")
	return new SessionManager({ pool })
}

const sessionManager = await createSessionManager()
const auth = pool ? createAuthFromEnv() : undefined
const app = createApp(sessionManager, pool, auth, orchestrator)

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
	log.info(`Gateway listening on ${HOST}:${PORT}`)
})

// Attach WebSocket server using noServer mode
const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (request, socket, head) => {
	if (request.url === "/ws") {
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request)
		})
	} else {
		socket.destroy()
	}
})

wss.on("connection", (ws) => {
	handleWebSocket(ws, sessionManager)
})

// Start channel adapters (Slack, WhatsApp, etc.) when their env vars are set
const adapters = await initAdapters(sessionManager)

process.on("SIGTERM", async () => {
	for (const adapter of adapters) {
		await adapter.shutdown()
	}
	process.exit(0)
})
