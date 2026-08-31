import type { Metadata } from "next"

import { dataDir } from "@/lib/settings/server"

import { SettingsView } from "./settings-view"

export const metadata: Metadata = {
  title: "Settings",
}

/** `dataDir()` reads AGENT_UI_DIR at request time, so nothing is prerendered. */
export const dynamic = "force-dynamic"

export default function SettingsPage() {
  return <SettingsView dataDir={dataDir()} />
}
