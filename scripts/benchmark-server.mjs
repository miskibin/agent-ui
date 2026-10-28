// Times isolated production Node sidecar starts, excluding build and staging.
import { startApp } from "../tests/e2e/server.mjs"

const values = []
for (let i = 0; i < 5; i++) {
  const app = await startApp()
  values.push(app.startupMs)
  await app.stop()
}
values.sort((a, b) => a - b)
console.log(JSON.stringify({ samples: values.length, medianMs: +values[2].toFixed(1), maxMs: +values[4].toFixed(1) }, null, 2))
