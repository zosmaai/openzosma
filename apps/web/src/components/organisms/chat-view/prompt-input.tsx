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
import { DropdownMenuItem } from "@/src/components/ui/dropdown-menu"
import { IconFiles } from "@tabler/icons-react"
import type { FileUIPart } from "ai"
import { useCallback, useState } from "react"

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
	return (
		<PromptInputComponent onSubmit={handlesubmit} className="rounded-2xl border shadow-lg">
			<PromptInputAttachments>{(file) => <PromptInputAttachment data={file} />}</PromptInputAttachments>
			<PromptInputTextarea placeholder={hasmessages ? "Type a message..." : "Ask anything..."} ref={textarearef} />
			<PromptInputFooter>
				<PromptInputTools>
					<PromptInputActionMenu>
						<PromptInputActionMenuTrigger />
						<PromptInputActionMenuContent>
							<PromptInputActionAddAttachments />
							<MyFilesMenuItem />
						</PromptInputActionMenuContent>
					</PromptInputActionMenu>
				</PromptInputTools>
				<PromptInputSubmit disabled={streaming} status={streaming ? "streaming" : undefined} />
			</PromptInputFooter>
		</PromptInputComponent>
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
