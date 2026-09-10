import assert from "node:assert/strict"
import { test } from "node:test"

import { healthResponse } from "@/lib/health"

const LAUNCH_HEADER = "x-agent-ui-launch"

test("health returns the sidecar token without a response body", async () => {
  const response = healthResponse("sidecar-token")
  assert.equal(response.status, 204)
  assert.equal(response.headers.get(LAUNCH_HEADER), "sidecar-token")
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(await response.text(), "")
})

test("health omits the launch header when no sidecar token is configured", async () => {
  const response = healthResponse(undefined)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get(LAUNCH_HEADER), null)
  assert.equal(response.headers.get("cache-control"), "no-store")
})
