import { auth } from "@/src/lib/auth"
import { GATEWAY_URL } from "@/src/lib/constants"
import { headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"

/**
 * GET /api/files/list?path=/
 *
 * Proxies to gateway GET /api/v1/files/list?path=... to list a single directory.
 */
export const GET = async (req: NextRequest) => {
	const reqHeaders = await headers()
	const session = await auth.api.getSession({ headers: reqHeaders })
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	const path = req.nextUrl.searchParams.get("path") || "/"
	const qs = `?path=${encodeURIComponent(path)}`

	try {
		const response = await fetch(`${GATEWAY_URL}/api/v1/files/list${qs}`, {
			headers: { cookie: reqHeaders.get("cookie") ?? "" },
		})
		const data = await response.json()
		return NextResponse.json(data, { status: response.status })
	} catch (err) {
		console.error("[files/list] Gateway proxy failed:", err)
		return NextResponse.json({ error: "Failed to reach gateway" }, { status: 502 })
	}
}
