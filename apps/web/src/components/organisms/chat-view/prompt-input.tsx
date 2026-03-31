import {
	PromptInputActionAddAttachments,
	PromptInputActionMenu,
	PromptInputActionMenuContent,
	PromptInputActionMenuTrigger,
	PromptInputAttachment,
	PromptInputAttachments,
	PromptInput as PromptInputComponent,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
} from "@/src/components/ai-elements/prompt-input"
import MyFilesPicker from "@/src/components/organisms/chat-view/my-files-picker"
import {
	SLASH_COMMANDS,
	SlashCommandPicker,
	type SlashCommandPickerRef,
} from "@/src/components/organisms/chat-view/slash-command-picker"
import { Button } from "@/src/components/ui/button"
import { DropdownMenuItem } from "@/src/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/src/components/ui/popover"
import { IconFiles } from "@tabler/icons-react"
import type { FileUIPart } from "ai"
import { useCallback, useRef, useState } from "react"

const PromptInput = ({
	handlesubmit,
	hasmessages,
	textarearef,
	streaming,
}: {
	handlesubmit: (msg: { text: string; files: FileUIPart[] }) => void
	hasmessages: boolean
	textarearef: React.RefObject<HTMLTextAreaElement>
	streaming: boolean
}) => {
	const [inputValue, setInputValue] = useState("")
	const [modelOpen, setModelOpen] = useState(false)
	const pickerRef = useRef<SlashCommandPickerRef>(null)
	const slashActive = !streaming && inputValue.startsWith("/") && !inputValue.includes(" ")
	const slashQuery = slashActive ? inputValue.slice(1) : ""

	const handleCommandSelect = useCallback(
		(command: string) => {
			setInputValue(`/${command} `)
			textarearef.current?.focus()
		},
		[textarearef],
	)

	const handleDismiss = useCallback(() => {
		setInputValue((v) => (v.startsWith("/") && !v.includes(" ") ? "" : v))
	}, [])

	// Wrap the submit callback to clear controlled state after the form submits
	const wrappedHandleSubmit = useCallback(
		(msg: { text: string; files: FileUIPart[] }) => {
			setInputValue("")
			return handlesubmit(msg)
		},
		[handlesubmit],
	)

	const handleModelSelect = useCallback(
		(model: (typeof SLASH_COMMANDS)[number]) => {
			setInputValue(`/${model.command} `)
			textarearef.current?.focus()
			setModelOpen(false)
		},
		[textarearef],
	)

	return (
		<div
			className="relative"
			onKeyDownCapture={(e) => {
				if (!slashActive) return
				if (pickerRef.current?.handleKeyDown(e)) return
				if (e.key === "Escape") {
					e.preventDefault()
					e.stopPropagation()
					handleDismiss()
				}
			}}
		>
			{slashActive && <SlashCommandPicker ref={pickerRef} query={slashQuery} onSelect={handleCommandSelect} />}
			<PromptInputComponent onSubmit={wrappedHandleSubmit} className="rounded-2xl border shadow-lg">
				<PromptInputAttachments>{(file) => <PromptInputAttachment data={file} />}</PromptInputAttachments>
				<PromptInputTextarea
					placeholder={hasmessages ? "Type a message..." : "Ask anything..."}
					ref={textarearef}
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
				/>
				<PromptInputFooter>
					<PromptInputTools>
						<PromptInputActionMenu>
							<PromptInputActionMenuTrigger />
							<PromptInputActionMenuContent>
								<PromptInputActionAddAttachments />
								<MyFilesMenuItem />
							</PromptInputActionMenuContent>
						</PromptInputActionMenu>
						<Popover open={modelOpen} onOpenChange={setModelOpen}>
							<PopoverTrigger>
								<div className="border-0 cursor-pointer hover:bg-accent hover:text-accent-foreground py-2 px-4 rounded-md">
									Mode
								</div>
							</PopoverTrigger>
							<PopoverContent
								align="start"
								className="flex flex-col gap-2 w-fit px-4"
								onKeyDown={(e) => {
									if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
									e.preventDefault()
									const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"))
									if (buttons.length === 0) return
									const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
									const next =
										e.key === "ArrowDown" ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length
									buttons[next].focus()
								}}
							>
								{SLASH_COMMANDS.map((command) => (
									<Button
										key={command.command}
										onClick={() => handleModelSelect(command)}
										variant="ghost"
										className="border-0 w-fit"
									>
										{command.label}
									</Button>
								))}
							</PopoverContent>
						</Popover>
					</PromptInputTools>
					<PromptInputSubmit disabled={streaming} status={streaming ? "streaming" : undefined} />
				</PromptInputFooter>
			</PromptInputComponent>
		</div>
	)
}

/**
 * Dropdown menu item that opens the My Files picker dialog.
 * Must be rendered inside a PromptInput to access the attachments context.
 */
const MyFilesMenuItem = () => {
	const [pickerOpen, setPickerOpen] = useState(false)
	const attachments = usePromptInputAttachments()

	const handleFilesSelected = useCallback(
		(files: File[]) => {
			attachments.add(files)
		},
		[attachments],
	)

	return (
		<>
			<DropdownMenuItem
				onSelect={(e) => {
					e.preventDefault()
					setPickerOpen(true)
				}}
			>
				<IconFiles className="mr-2 size-4" /> Attach from My Files
			</DropdownMenuItem>
			<MyFilesPicker open={pickerOpen} onOpenChange={setPickerOpen} onFilesSelected={handleFilesSelected} />
		</>
	)
}

export default PromptInput
