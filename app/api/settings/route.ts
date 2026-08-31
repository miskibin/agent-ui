import { NextResponse } from "next/server"

import { readSettings, writeSettings } from "@/lib/settings/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(await readSettings())
}

export async function PUT(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  return NextResponse.json(await writeSettings(body))
}
