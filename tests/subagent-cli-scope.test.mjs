import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

test('CLI preserves the parent and permission mode when launching a subagent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ui-cli-'))
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ result: { structuredContent: { run_id: 'r1', session_id: 'child', status: 'running' } } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    await writeFile(join(dir, 'bridge.json'), JSON.stringify({ url, token: 'test-token' }))
    const child = spawn(process.execPath, ['bin/agent-ui.mjs', 'run', 'ollama', '--background', 'test'], {
      env: { ...process.env, AGENT_UI_DIR: dir, AGENT_UI_MCP_URL: `${url}/api/mcp?parent=parent1&mode=read-only` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    const code = await new Promise(resolve => child.on('close', resolve))
    assert.equal(code, 0, error)
    assert.equal(requests[0].url, '/api/mcp?parent=parent1&mode=read-only')
    assert.equal(requests[0].auth, 'Bearer test-token')
    assert.equal(requests[0].body.params.name, 'run_subagent')
    assert.equal(requests[0].body.params.arguments.background, true)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
