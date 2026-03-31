import { describe, expect, it } from "vitest"
import { ALLOWED_TOOLS, applySlashCommand } from "./command-parser.js"

describe("ALLOWED_TOOLS", () => {
	it("restricts plan to read-only tools", () => {
		expect(ALLOWED_TOOLS.plan).toEqual(["read", "grep", "find", "ls"])
	})

	it("restricts ask to read-only tools", () => {
		expect(ALLOWED_TOOLS.ask).toEqual(["read", "grep", "find", "ls"])
	})

	it("allows all tools in build mode", () => {
		expect(ALLOWED_TOOLS.build).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"])
	})
})

describe("applySlashCommand", () => {
	it("returns plain messages unchanged", () => {
		expect(applySlashCommand("just a normal message")).toBe("just a normal message")
		expect(applySlashCommand("")).toBe("")
		expect(applySlashCommand("  hello world  ")).toBe("  hello world  ")
	})

	it("does not match unknown slash commands", () => {
		expect(applySlashCommand("/unknown do something")).toBe("/unknown do something")
		expect(applySlashCommand("/help")).toBe("/help")
	})

	it("handles /plan with a task", () => {
		const result = applySlashCommand("/plan build an auth system")
		expect(result).toContain("<mode>plan</mode>")
		expect(result).toContain("<allowed_tools>read, grep, find, ls</allowed_tools>")
		expect(result).toContain("<task>\nbuild an auth system\n</task>")
		expect(result).toContain("<mode_instructions>")
		expect(result).not.toContain("<mode>ask</mode>")
		expect(result).not.toContain("<mode>build</mode>")
	})

	it("handles /ask with a question", () => {
		const result = applySlashCommand("/ask what does the auth middleware do?")
		expect(result).toContain("<mode>ask</mode>")
		expect(result).toContain("<allowed_tools>read, grep, find, ls</allowed_tools>")
		expect(result).toContain("<question>\nwhat does the auth middleware do?\n</question>")
	})

	it("handles /build with a task", () => {
		const result = applySlashCommand("/build implement user profile page")
		expect(result).toContain("<mode>build</mode>")
		expect(result).toContain("<allowed_tools>read, bash, edit, write, grep, find, ls</allowed_tools>")
		expect(result).toContain("<task>\nimplement user profile page\n</task>")
	})

	it("is case-insensitive for the command", () => {
		expect(applySlashCommand("/PLAN do something")).toContain("<mode>plan</mode>")
		expect(applySlashCommand("/Ask a question")).toContain("<mode>ask</mode>")
		expect(applySlashCommand("/BUILD a thing")).toContain("<mode>build</mode>")
	})

	it("handles /plan with no trailing text", () => {
		const result = applySlashCommand("/plan")
		expect(result).toContain("<mode>plan</mode>")
		expect(result).toContain("<task>\n\n</task>")
	})

	it("handles /ask with no trailing text", () => {
		const result = applySlashCommand("/ask")
		expect(result).toContain("<mode>ask</mode>")
		expect(result).toContain("<question>\n\n</question>")
	})

	it("preserves multiline task content", () => {
		const result = applySlashCommand("/plan\nstep one\nstep two")
		expect(result).toContain("<mode>plan</mode>")
		expect(result).toContain("step one\nstep two")
	})
})
