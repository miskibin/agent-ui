import { NextResponse } from "next/server"

import {
  harnessDisplayName,
  isHarnessProviderId,
  setHarnessBinaryPath,
} from "@/lib/harness-binary"
import { listProviders } from "@/lib/providers/registry"
import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings, writeSettings } from "@/lib/settings/server"
import { pickWindowsFile } from "@/lib/windows-file-dialog"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export type ConfigureBinaryResponse =
  | { cancelled: true }
  | { path: string; providers: Awaited<ReturnType<typeof listProviders>> }

/**
 * Windows-only: open a native file dialog, save the picked path as that
 * harness's binary, and return the refreshed provider list.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused
  if (process.platform !== "win32") {
    return NextResponse.json(
      { error: "Configuring a harness binary from the picker is Windows-only." },
      { status: 501 }
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const providerId =
    body &&
    typeof body === "object" &&
    "providerId" in body &&
    typeof body.providerId === "string"
      ? body.providerId.trim()
      : ""

  if (!providerId || !isHarnessProviderId(providerId)) {
    return NextResponse.json(
      { error: "That provider has no binary to locate." },
      { status: 400 }
    )
  }

  const settings = await readSettings()
  const name = harnessDisplayName(settings, providerId)
  if (!name) {
    return NextResponse.json(
      { error: "Unknown provider." },
      { status: 404 }
    )
  }

  let picked: string | null
  try {
    picked = await pickWindowsFile({ title: `Locate ${name}` })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "The file dialog could not be opened.",
      },
      { status: 500 }
    )
  }

  if (!picked) {
    return NextResponse.json<ConfigureBinaryResponse>({ cancelled: true })
  }

  const latest = await readSettings()
  await writeSettings(setHarnessBinaryPath(latest, providerId, picked))
  const providers = await listProviders()
  return NextResponse.json<ConfigureBinaryResponse>({
    path: picked,
    providers,
  })
}
