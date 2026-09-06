import test from "node:test"
import assert from "node:assert/strict"

import { hasDeepSeekCredentials } from "@/lib/providers/acp-availability"

const agent = (kind: "dsh" | "generic", apiKey = "") => ({
  kind,
  dsh: { apiKey },
})

test("hosted DeepSeek credentials only make the dsh ACP agent eligible", () => {
  const inherited = process.env.DEEPSEEK_API_KEY
  try {
    delete process.env.DEEPSEEK_API_KEY
    assert.equal(hasDeepSeekCredentials(agent("dsh", "hosted-key")), true)
    assert.equal(hasDeepSeekCredentials(agent("generic", "hosted-key")), false)
    assert.equal(hasDeepSeekCredentials(agent("dsh")), false)

    process.env.DEEPSEEK_API_KEY = "inherited-key"
    assert.equal(hasDeepSeekCredentials(agent("dsh")), true)
    assert.equal(hasDeepSeekCredentials(agent("generic")), false)
  } finally {
    if (inherited === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = inherited
  }
})
