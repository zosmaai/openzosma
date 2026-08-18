import { createLogger } from "@openzosma/logger"
import type { SessionManager } from "./session-manager.js"

const log = createLogger({ component: "gateway" })

/**
 * Common contract for all channel adapters (Slack, WhatsApp, etc.).
 *
 * Adapters are lightweight translators: they receive inbound messages from
 * an external platform, map them to orchestrator sessions, and stream
 * agent responses back to the platform. They contain no business logic.
 */
export interface ChannelAdapter {
	/** Human-readable adapter name used in logs. */
	readonly name: string
	/** Start the adapter (connect to platform, register event handlers). */
	init(sessionManager: SessionManager): Promise<void>
	/** Gracefully disconnect and release resources. */
	shutdown(): Promise<void>
}

/**
 * Config shape expected by SlackAdapter constructor.
 * Duplicated here to avoid a package dependency on @openzosma/adapter-slack
 * (which would create a circular workspace dependency).
 */
interface SlackAdapterConfig {
	botToken: string
	appToken?: string
}

interface WhatsAppAdapterConfig {
	accessToken: string
	verifyToken: string
	appSecret?: string
	phoneNumberId?: string
	apiVersion?: string
}

/** Optional webhook route registration used by HTTP-based adapters (WhatsApp). */
export interface HttpChannelAdapter extends ChannelAdapter {
	handleVerify?(query: Record<string, string | undefined>): { status: number; body: string }
	handleWebhook?(
		rawBody: string,
		signatureHeader: string | undefined,
	): Promise<{ status: number; body: { ok?: boolean; error?: string } }>
}

/**
 * Initialize all configured channel adapters at gateway startup.
 * Adapters are enabled by the presence of their required env vars.
 */
export const initAdapters = async (sessionManager: SessionManager): Promise<HttpChannelAdapter[]> => {
	const adapters: HttpChannelAdapter[] = []

	if (process.env.SLACK_BOT_TOKEN) {
		// Dynamic import keeps adapter-slack out of the gateway's compiled output.
		// adapter-slack depends on gateway for types, but there is no circular
		// build edge because this import is dynamic and cast at runtime.
		const mod = (await import(/* webpackIgnore: true */ "@openzosma/adapter-slack" as string)) as {
			SlackAdapter: new (config: SlackAdapterConfig) => ChannelAdapter
		}
		adapters.push(
			new mod.SlackAdapter({
				botToken: process.env.SLACK_BOT_TOKEN,
				appToken: process.env.SLACK_APP_TOKEN,
			}),
		)
	}

	if (process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_VERIFY_TOKEN) {
		const mod = (await import(/* webpackIgnore: true */ "@openzosma/adapter-whatsapp" as string)) as {
			WhatsAppAdapter: new (config: WhatsAppAdapterConfig) => HttpChannelAdapter
		}
		adapters.push(
			new mod.WhatsAppAdapter({
				accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
				verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
				appSecret: process.env.WHATSAPP_APP_SECRET,
				phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
				apiVersion: process.env.WHATSAPP_API_VERSION,
			}),
		)
	}

	for (const adapter of adapters) {
		await adapter.init(sessionManager)
		log.info(`Adapter started: ${adapter.name}`)
	}

	return adapters
}
