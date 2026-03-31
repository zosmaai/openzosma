"use client"

import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/src/components/ui/command"
import { type KeyboardEvent, forwardRef, useImperativeHandle, useState } from "react"

export const SLASH_COMMANDS = [
	{
		command: "plan",
		label: "/plan",
		description: "Write a step-by-step plan — no code execution",
	},
	{
		command: "ask",
		label: "/ask",
		description: "Ask a question — no file changes",
	},
	{
		command: "build",
		label: "/build",
		description: "Implement the task completely",
	},
] as const

export interface SlashCommandPickerRef {
	handleKeyDown: (e: KeyboardEvent) => boolean
}

interface Props {
	query: string
	onSelect: (command: string) => void
}

export const SlashCommandPicker = forwardRef<SlashCommandPickerRef, Props>(({ query, onSelect }, ref) => {
	const filtered = SLASH_COMMANDS.filter((c) => c.command.startsWith(query.toLowerCase()))
	const [selected, setSelected] = useState("")

	const effectiveSelected =
		selected && filtered.some((c) => c.command === selected) ? selected : (filtered[0]?.command ?? "")

	useImperativeHandle(
		ref,
		() => ({
			handleKeyDown: (e) => {
				if (filtered.length === 0) return false

				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault()
					e.stopPropagation()
					const currentIndex = Math.max(
						0,
						filtered.findIndex((c) => c.command === effectiveSelected),
					)
					const next =
						e.key === "ArrowDown"
							? (currentIndex + 1) % filtered.length
							: (currentIndex - 1 + filtered.length) % filtered.length
					setSelected(filtered[next].command)
					return true
				}

				if (e.key === "Enter") {
					e.preventDefault()
					e.stopPropagation()
					const target = filtered.find((c) => c.command === effectiveSelected) ?? filtered[0]
					if (target) onSelect(target.command)
					return true
				}

				return false
			},
		}),
		[filtered, effectiveSelected, onSelect],
	)

	if (filtered.length === 0) return null

	return (
		<div className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-lg border bg-popover shadow-md">
			<Command value={effectiveSelected} onValueChange={setSelected}>
				<CommandList>
					<CommandEmpty>No commands found.</CommandEmpty>
					<CommandGroup heading="Commands">
						{filtered.map((c) => (
							<CommandItem
								key={c.command}
								value={c.command}
								onSelect={() => onSelect(c.command)}
								className="flex flex-col items-start gap-0.5"
							>
								<span className="font-mono text-sm font-medium">{c.label}</span>
								<span className="text-muted-foreground text-xs">{c.description}</span>
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</div>
	)
})

SlashCommandPicker.displayName = "SlashCommandPicker"
