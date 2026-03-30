// ICONS
import { IconArrowLeft, IconFiles, IconMessageCircle, IconPlug, IconSettings } from "@tabler/icons-react"

type SidebarItem = {
	id: string
	label: string
	href: string
	icon: React.ReactNode
	hasflyout?: boolean
}

export type { SidebarItem }

export const getSidebarItems = (): SidebarItem[] => [
	{
		id: "chat",
		label: "Chat",
		href: "/chat",
		icon: <IconMessageCircle className="h-5 w-5 shrink-0 text-neutral-700 dark:text-neutral-200" />,
		hasflyout: true,
	},
	{
		id: "files",
		label: "Files",
		href: "/files",
		icon: <IconFiles className="h-5 w-5 shrink-0 text-neutral-700 dark:text-neutral-200" />,
	},
	{
		id: "integrations",
		label: "Integrations",
		href: "/integrations",
		icon: <IconPlug className="h-5 w-5 shrink-0 text-neutral-700 dark:text-neutral-200" />,
	},
	{
		id: "settings",
		label: "Settings",
		href: "/settings",
		icon: <IconSettings className="h-5 w-5 shrink-0 text-neutral-700 dark:text-neutral-200" />,
	},
	{
		id: "logout",
		label: "Logout",
		href: "/api/auth/sign-out",
		icon: <IconArrowLeft className="h-5 w-5 shrink-0 text-neutral-700 dark:text-neutral-200" />,
	},
]
