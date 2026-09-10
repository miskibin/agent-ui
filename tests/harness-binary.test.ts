import assert from "node:assert/strict"
import { test } from "node:test"

import {
  harnessDisplayName,
  isHarnessProviderId,
  setHarnessBinaryPath,
} from "@/lib/harness-binary"
import { CODEX_PROVIDER_ID } from "@/lib/providers/codex"
import { DEFAULT_SETTINGS } from "@/lib/settings/schema"

test("Codex participates in the harness binary picker", () => {
  assert.equal(isHarnessProviderId(CODEX_PROVIDER_ID), true)
  assert.equal(harnessDisplayName(DEFAULT_SETTINGS, CODEX_PROVIDER_ID), "Codex")

  const updated = setHarnessBinaryPath(
    DEFAULT_SETTINGS,
    CODEX_PROVIDER_ID,
    "C:\\Tools\\codex.exe"
  )
  assert.equal(updated.providers.codex.binPath, "C:\\Tools\\codex.exe")
  assert.equal(updated.providers.codex.workspace, DEFAULT_SETTINGS.providers.codex.workspace)
  assert.equal(updated.providers.claudeCode, DEFAULT_SETTINGS.providers.claudeCode)
})
