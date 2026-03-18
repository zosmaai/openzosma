// Pool
export { createPool } from "./pool.js"
export type { PoolConfig } from "./pool.js"

// Types
export type {
	User,
	Session,
	SessionStatus,
	Message,
	MessageRole,
	AgentConfig,
	ApiKey,
	UsageRecord,
	Connection,
	ConnectionType,
	Setting,
} from "./types.js"

// Queries
export * as userQueries from "./queries/users.js"
export * as sessionQueries from "./queries/sessions.js"
export * as messageQueries from "./queries/messages.js"
export * as agentConfigQueries from "./queries/agent-configs.js"
export * as apiKeyQueries from "./queries/api-keys.js"
export * as usageQueries from "./queries/usage.js"
export * as connectionQueries from "./queries/connections.js"
export * as settingQueries from "./queries/settings.js"

// Migration runner
export { runMigrations } from "./migrate.js"
