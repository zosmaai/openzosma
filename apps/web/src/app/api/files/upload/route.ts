import { auth } from "@/src/lib/auth"
import { GATEWAY_URL } from "@/src/lib/constants"
import { headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"

/**
 * POST /api/files/upload?path=/
 *
 * Proxies multipart file upload to gateway POST /api/v1/files/upload?path=...
 * Forwards the raw request body to preserve the multipart boundary.
 */
export const POST = async (req: NextRequest) => {
	const reqHeaders = await headers()
	const session = await auth.api.getSession({ headers: reqHeaders })
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	const path = req.nextUrl.searchParams.get("path") || "/"
	const qs = `?path=${encodeURIComponent(path)}`

	try {
		const contentType = req.headers.get("content-type") ?? ""
		const body = await req.arrayBuffer()

		const response = await fetch(`${GATEWAY_URL}/api/v1/files/upload${qs}`, {
			method: "POST",
			headers: {
				cookie: reqHeaders.get("cookie") ?? "",
				"content-type": contentType,
			},
			body,
		})

		const data = await response.json()
		return NextResponse.json(data, { status: response.status })
	} catch (err) {
		console.error("[files/upload] Gateway proxy failed:", err)
		return NextResponse.json({ error: "Failed to reach gateway" }, { status: 502 })
	}
}
