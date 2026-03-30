import { auth } from "@/src/lib/auth"
import { GATEWAY_URL } from "@/src/lib/constants"
import { headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"

/**
 * DELETE /api/files?path=...
 *
 * Proxies deletion to gateway DELETE /api/v1/files?path=...
 */
export const DELETE = async (req: NextRequest) => {
	const reqHeaders = await headers()
	const session = await auth.api.getSession({ headers: reqHeaders })
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	const path = req.nextUrl.searchParams.get("path")
	if (!path) {
		return NextResponse.json({ error: "path query parameter is required" }, { status: 400 })
	}

	try {
		const response = await fetch(`${GATEWAY_URL}/api/v1/files?path=${encodeURIComponent(path)}`, {
			method: "DELETE",
			headers: { cookie: reqHeaders.get("cookie") ?? "" },
		})
		const data = await response.json()
		return NextResponse.json(data, { status: response.status })
	} catch (err) {
		console.error("[files] Gateway DELETE proxy failed:", err)
		return NextResponse.json({ error: "Failed to reach gateway" }, { status: 502 })
	}
}
