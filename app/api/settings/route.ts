import { NextResponse } from "next/server"

import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings, writeSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(await readSettings())
}

export async function PUT(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  return NextResponse.json(await writeSettings(body))
}
