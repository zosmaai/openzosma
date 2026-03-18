import { Hono } from "hono"
import { cors } from "hono/cors"
import type { SessionManager } from "./session-manager.js"

export function createApp(sessionManager: SessionManager): Hono {
	const app = new Hono()

	app.use(
		"*",
		cors({
			origin: ["http://localhost:3000"],
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["Content-Type"],
		}),
	)

	app.get("/health", (c) => c.json({ status: "ok" }))

	// Create a new session
	app.post("/api/v1/sessions", (c) => {
		const session = sessionManager.createSession()
		return c.json({ id: session.id, createdAt: session.createdAt }, 201)
	})

	// Get session details
	app.get("/api/v1/sessions/:id", (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json({
			id: session.id,
			createdAt: session.createdAt,
			messageCount: session.messages.length,
		})
	})

	// Send a message (non-streaming REST fallback)
	app.post("/api/v1/sessions/:id/messages", async (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}

		const body = await c.req.json<{ content: string }>()
		if (!body.content) {
			return c.json({ error: "content is required" }, 400)
		}

		const events = []
		for await (const event of sessionManager.sendMessage(c.req.param("id"), body.content)) {
			events.push(event)
		}

		// Collect full response text from message_update events
		const text = events
			.filter((e) => e.type === "message_update" && e.text)
			.map((e) => e.text)
			.join("")

		return c.json({ role: "assistant", content: text })
	})

	// Get messages for a session
	app.get("/api/v1/sessions/:id/messages", (c) => {
		const session = sessionManager.getSession(c.req.param("id"))
		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}
		return c.json(session.messages)
	})

	return app
}
