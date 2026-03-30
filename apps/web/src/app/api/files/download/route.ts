import { auth } from "@/src/lib/auth"
import { GATEWAY_URL } from "@/src/lib/constants"
import { headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"

/**
 * GET /api/files/download?path=...
 *
 * Proxies file content download from gateway GET /api/v1/files/download?path=...
 * Streams the response body to avoid buffering large files in memory.
 */
export const GET = async (req: NextRequest) => {
	const reqHeaders = await headers()
	const session = await auth.api.getSession({ headers: reqHeaders })
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
	}

	const path = req.nextUrl.searchParams.get("path")
	if (!path) {
		return NextResponse.json({ error: "path query parameter is required" }, { status: 400 })
	}

	const download = req.nextUrl.searchParams.get("download")
	const qs = new URLSearchParams({ path })
	if (download === "true") qs.set("download", "true")

	try {
		const response = await fetch(`${GATEWAY_URL}/api/v1/files/download?${qs.toString()}`, {
			headers: { cookie: reqHeaders.get("cookie") ?? "" },
		})

		if (!response.ok) {
			const data = await response.json().catch(() => ({ error: "Download failed" }))
			return NextResponse.json(data, { status: response.status })
		}

		const contentType = response.headers.get("Content-Type") ?? "application/octet-stream"
		const contentLength = response.headers.get("Content-Length")
		const contentDisposition = response.headers.get("Content-Disposition")

		const responseHeaders = new Headers()
		responseHeaders.set("Content-Type", contentType)
		if (contentLength) responseHeaders.set("Content-Length", contentLength)
		if (contentDisposition) responseHeaders.set("Content-Disposition", contentDisposition)
		responseHeaders.set("Cache-Control", "private, max-age=3600")

		return new NextResponse(response.body, {
			status: 200,
			headers: responseHeaders,
		})
	} catch (err) {
		console.error("[files/download] Gateway proxy failed:", err)
		return NextResponse.json({ error: "Failed to download file" }, { status: 502 })
	}
}
