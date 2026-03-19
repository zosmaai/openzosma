import { randomUUID } from "node:crypto"
import { Agent, type AgentEvent as PiAgentEvent } from "@mariozechner/pi-agent-core"
import { getEnvApiKey, getModel, getModels, getProviders } from "@mariozechner/pi-ai"
import type { Api, Model } from "@mariozechner/pi-ai"
import {
	convertToLlm,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent"
import type { AgentMessage, AgentProvider, AgentSession, AgentSessionOpts, AgentStreamEvent } from "./types.js"

/** Preferred providers in priority order when auto-detecting. */
const PROVIDER_PREFERENCE = ["anthropic", "openai", "google", "groq", "xai", "mistral"] as const

/** Default model IDs per provider (used when OPENZOSMA_MODEL_ID is not set). */
const DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-4-20250514",
	openai: "gpt-4o",
	google: "gemini-2.5-flash-preview-05-20",
	groq: "llama-3.3-70b-versatile",
	xai: "grok-3",
	mistral: "mistral-large-latest",
}

/**
 * Resolve the model to use. Priority:
 * 1. Explicit OPENZOSMA_MODEL_PROVIDER + OPENZOSMA_MODEL_ID env vars
 * 2. Auto-detect from available API keys using PROVIDER_PREFERENCE order
 */
function resolveModel(): { model: Model<Api>; apiKey: string } {
	const explicitProvider = process.env.OPENZOSMA_MODEL_PROVIDER
	const explicitModelId = process.env.OPENZOSMA_MODEL_ID

	// Explicit configuration
	if (explicitProvider) {
		const modelId = explicitModelId ?? DEFAULT_MODELS[explicitProvider]
		if (!modelId) {
			throw new Error(
				`OPENZOSMA_MODEL_PROVIDER is "${explicitProvider}" but no OPENZOSMA_MODEL_ID was set and no default model is known for this provider.`,
			)
		}
		const model = getModel(explicitProvider as "anthropic", modelId as "claude-sonnet-4-20250514")
		if (!model) {
			throw new Error(`Model ${explicitProvider}/${modelId} not found in model registry.`)
		}
		const apiKey = getEnvApiKey(explicitProvider)
		if (!apiKey) {
			throw new Error(`No API key found for provider "${explicitProvider}". Set the appropriate environment variable.`)
		}
		return { model, apiKey }
	}

	// Auto-detect: try providers in preference order
	for (const provider of PROVIDER_PREFERENCE) {
		const apiKey = getEnvApiKey(provider)
		if (!apiKey) continue

		const modelId = explicitModelId ?? DEFAULT_MODELS[provider]
		if (!modelId) continue

		const model = getModel(provider as "anthropic", modelId as "claude-sonnet-4-20250514")
		if (!model) continue

		return { model, apiKey }
	}

	// Last resort: scan all providers
	for (const provider of getProviders()) {
		const apiKey = getEnvApiKey(provider)
		if (!apiKey) continue

		const models = getModels(provider as "anthropic")
		if (models.length === 0) continue

		return { model: models[0] as Model<Api>, apiKey }
	}

	throw new Error(
		"No LLM provider configured. Set OPENZOSMA_MODEL_PROVIDER or provide an API key (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY).",
	)
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant running inside the OpenZosma platform.
You have access to tools for reading files, writing files, editing files, executing shell commands, searching file contents, finding files, and listing directories.
Use these tools when the user asks you to work with files, code, or the system.
Be direct and concise. When showing code, use markdown code blocks with language annotations.`

/** A Pi Agent-backed session. */
class PiAgentSession implements AgentSession {
	private agent: Agent
	private messages: AgentMessage[] = []

	constructor(opts: AgentSessionOpts) {
		const toolList = [
			createReadTool(opts.workspaceDir),
			createBashTool(opts.workspaceDir),
			createEditTool(opts.workspaceDir),
			createWriteTool(opts.workspaceDir),
			createGrepTool(opts.workspaceDir),
			createFindTool(opts.workspaceDir),
			createLsTool(opts.workspaceDir),
		]

		const { model } = resolveModel()

		this.agent = new Agent({
			initialState: {
				systemPrompt: DEFAULT_SYSTEM_PROMPT,
				model,
				thinkingLevel: "off",
				tools: toolList,
			},
			convertToLlm,
			getApiKey: (provider: string) => {
				return getEnvApiKey(provider)
			},
		})
	}

	async *sendMessage(content: string, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
		// Store user message
		const userMsg: AgentMessage = {
			id: randomUUID(),
			role: "user",
			content,
			createdAt: new Date().toISOString(),
		}
		this.messages.push(userMsg)

		// Set up a queue to bridge the event-subscription model to an async generator.
		// Pi Agent uses subscribe() (callback-based), but we need yield (generator-based).
		const eventQueue: AgentStreamEvent[] = []
		let resolveWaiting: (() => void) | null = null
		let done = false

		function enqueue(event: AgentStreamEvent): void {
			eventQueue.push(event)
			if (resolveWaiting) {
				resolveWaiting()
				resolveWaiting = null
			}
		}

		let fullResponseText = ""
		let messageId = randomUUID()

		const unsubscribe = this.agent.subscribe((event: PiAgentEvent) => {
			switch (event.type) {
				case "agent_start":
					enqueue({ type: "turn_start", id: randomUUID() })
					break

				case "message_start":
					// Only forward assistant messages -- the agent loop echoes user messages too
					if (event.message.role === "assistant") {
						messageId = randomUUID()
						fullResponseText = ""
						enqueue({ type: "message_start", id: messageId })
					}
					break

				case "message_update": {
					const assistantEvent = event.assistantMessageEvent
					if (assistantEvent.type === "text_delta") {
						fullResponseText += assistantEvent.delta
						enqueue({ type: "message_update", id: messageId, text: assistantEvent.delta })
					} else if (assistantEvent.type === "thinking_delta") {
						enqueue({ type: "thinking_update", id: messageId, text: assistantEvent.delta })
					}
					break
				}

				case "message_end":
					// Only forward assistant message ends
					if (event.message.role === "assistant") {
						enqueue({ type: "message_end", id: messageId })
					}
					break

				case "tool_execution_start":
					enqueue({
						type: "tool_call_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						toolArgs: typeof event.args === "string" ? event.args : JSON.stringify(event.args),
					})
					break

				case "tool_execution_update":
					enqueue({
						type: "tool_call_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
					})
					break

				case "tool_execution_end": {
					const resultText =
						event.result?.content
							?.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : ""))
							.join("") ?? ""
					enqueue({
						type: "tool_call_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						toolResult: resultText,
						isToolError: event.isError,
					})
					break
				}

				case "agent_end": {
					// Check if the agent ended with an error
					const errorMessages: string[] = []
					for (const m of event.messages) {
						if (m.role === "assistant" && "errorMessage" in m && m.errorMessage) {
							errorMessages.push(m.errorMessage)
						}
					}
					if (errorMessages.length > 0) {
						enqueue({ type: "error", error: errorMessages.join("; ") })
					}
					enqueue({ type: "turn_end", id: randomUUID() })
					done = true
					if (resolveWaiting) {
						resolveWaiting()
						resolveWaiting = null
					}
					break
				}

				case "turn_start":
				case "turn_end":
					// Internal turn boundaries within the agent loop -- no gateway-level event needed
					break
			}
		})

		// Handle abort
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					this.agent.abort()
				},
				{ once: true },
			)
		}

		// Start the agent prompt (fire-and-forget, events come via subscription)
		const promptPromise = this.agent.prompt(content).catch((err: unknown) => {
			const errorMsg = err instanceof Error ? err.message : "Unknown agent error"
			enqueue({ type: "error", error: errorMsg })
			done = true
			if (resolveWaiting) {
				resolveWaiting()
				resolveWaiting = null
			}
		})

		// Yield events as they arrive
		try {
			while (!done || eventQueue.length > 0) {
				if (eventQueue.length > 0) {
					const event = eventQueue.shift()!
					yield event
				} else if (!done) {
					await new Promise<void>((resolve) => {
						resolveWaiting = resolve
					})
				}
			}
		} finally {
			unsubscribe()
			await promptPromise
		}

		// Store assistant message for session history
		if (fullResponseText) {
			const assistantMsg: AgentMessage = {
				id: messageId,
				role: "assistant",
				content: fullResponseText,
				createdAt: new Date().toISOString(),
			}
			this.messages.push(assistantMsg)
		}
	}

	getMessages(): AgentMessage[] {
		return this.messages
	}
}

/** Agent provider backed by Pi (pi-agent-core + pi-coding-agent). */
export class PiAgentProvider implements AgentProvider {
	readonly id = "pi-coding"
	readonly name = "Pi Coding Agent"

	createSession(opts: AgentSessionOpts): AgentSession {
		return new PiAgentSession(opts)
	}
}
