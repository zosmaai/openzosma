import { auth } from "@/src/lib/auth"
import { GATEWAY_URL } from "@/src/lib/constants"
import { headers } from "next/headers"
import { NextResponse } from "next/server"

/**
 * GET /api/files/tree
 *
 * Proxies to gateway GET /api/v1/files/tree to return the full recursive file tree.
 */
export const GET = async () => {
	const reqHeaders = await headers()
	const session = await auth.api.getSession({ headers: reqHeaders })
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	try {
		const response = await fetch(`${GATEWAY_URL}/api/v1/files/tree`, {
			headers: { cookie: reqHeaders.get("cookie") ?? "" },
		})
		const data = await response.json()
		return NextResponse.json(data, { status: response.status })
	} catch (err) {
		console.error("[files/tree] Gateway proxy failed:", err)
		return NextResponse.json({ error: "Failed to reach gateway" }, { status: 502 })
	}
}
