import { auth } from "@/src/lib/auth"
import { GATEWAY_URL } from "@/src/lib/constants"
import { headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"

/**
 * POST /api/files/folder
 *
 * Proxies folder creation to gateway POST /api/v1/files/folder.
 * Body: { path: string }
 */
export const POST = async (req: NextRequest) => {
	const reqHeaders = await headers()
	const session = await auth.api.getSession({ headers: reqHeaders })
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	try {
		const body = await req.json()
		const response = await fetch(`${GATEWAY_URL}/api/v1/files/folder`, {
			method: "POST",
			headers: {
				cookie: reqHeaders.get("cookie") ?? "",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		})

		const data = await response.json()
		return NextResponse.json(data, { status: response.status })
	} catch (err) {
		console.error("[files/folder] Gateway proxy failed:", err)
		return NextResponse.json({ error: "Failed to reach gateway" }, { status: 502 })
	}
}
