export type Role = "admin" | "member"

export interface Permission {
	resource: string
	actions: string[]
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
	admin: [
		{ resource: "users", actions: ["read", "write", "delete"] },
		{ resource: "sessions", actions: ["read", "write", "delete"] },
		{ resource: "agent_configs", actions: ["read", "write", "delete"] },
		{ resource: "connections", actions: ["read", "write", "delete"] },
		{ resource: "settings", actions: ["read", "write"] },
		{ resource: "api_keys", actions: ["read", "write", "delete"] },
		{ resource: "sandboxes", actions: ["read", "delete"] },
		{ resource: "usage", actions: ["read"] },
		{ resource: "files", actions: ["read", "write", "delete"] },
	],
	member: [
		{ resource: "sessions", actions: ["read", "write"] },
		{ resource: "agent_configs", actions: ["read"] },
		{ resource: "sandboxes", actions: ["read", "delete"] },
		{ resource: "usage", actions: ["read"] },
		{ resource: "files", actions: ["read", "write", "delete"] },
	],
}

export function hasPermission(role: Role, resource: string, action: string): boolean {
	const permissions = ROLE_PERMISSIONS[role]
	if (!permissions) return false
	return permissions.some((p) => p.resource === resource && p.actions.includes(action))
}

export function getPermissions(role: Role): Permission[] {
	return ROLE_PERMISSIONS[role] ?? []
}
