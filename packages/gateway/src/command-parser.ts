/**
 * Slash command parser for the gateway message pipeline.
 *
 * Detects /plan, /ask, and /build prefixes and augments the message content
 * with mode-specific instructions before passing to the agent.
 *
 * Each mode declares an <allowed_tools> list that tells the model which tools
 * it may use. This is prompt-level enforcement only -- the underlying session
 * still has all tools available. When pi-mono gains per-message tool filtering,
 * the ALLOWED_TOOLS map can drive hard enforcement too.
 */

import type { BuiltInToolName } from "@openzosma/agents"

export type SlashCommand = "plan" | "ask" | "build"

const READ_ONLY_TOOLS: BuiltInToolName[] = ["read", "grep", "find", "ls"]
const ALL_TOOLS: BuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"]

/** Per-mode tool allow-lists. */
export const ALLOWED_TOOLS: Record<SlashCommand, BuiltInToolName[]> = {
	plan: READ_ONLY_TOOLS,
	ask: READ_ONLY_TOOLS,
	build: ALL_TOOLS,
}

/**
 * Parse a slash command prefix from a message and return an augmented content
 * string with mode-specific instructions prepended.
 *
 * If the message does not start with a recognised slash command, it is returned
 * unchanged.
 */
export const applySlashCommand = (content: string): string => {
	const match = content.match(/^\/(plan|ask|build)\s*([\s\S]*)$/i)
	if (!match) return content

	const command = match[1].toLowerCase() as SlashCommand
	const task = match[2].trim()
	const tools = ALLOWED_TOOLS[command].join(", ")

	switch (command) {
		case "plan":
			return `<mode>plan</mode>\n<allowed_tools>${tools}</allowed_tools>\n<mode_instructions>\nThink through the task carefully and produce a step-by-step plan. Do NOT execute code, run shell commands, or write/modify any files. You may only use the tools listed in <allowed_tools> to gather context.\n</mode_instructions>\n<task>\n${task}\n</task>`
		case "ask":
			return `<mode>ask</mode>\n<allowed_tools>${tools}</allowed_tools>\n<mode_instructions>\nAnswer the question. Do NOT write, create, or modify any files, and do NOT execute any shell commands. You may only use the tools listed in <allowed_tools> to gather context.\n</mode_instructions>\n<question>\n${task}\n</question>`
		case "build":
			return `<mode>build</mode>\n<allowed_tools>${tools}</allowed_tools>\n<mode_instructions>\nImplement the task completely. Write code, run tests, and ensure everything works. You may use any tool listed in <allowed_tools>.\n</mode_instructions>\n<task>\n${task}\n</task>`
	}
}
