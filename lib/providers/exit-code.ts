/**
 * The process exit code a harness's shell tool reported, if it reported one.
 *
 * Structural on purpose: it reads a field the backend itself published under
 * a name that means exactly this, and nothing else. It never infers a code
 * from prose in tool output and never invents `0` for a call that merely
 * succeeded — `status` already says that, and a fabricated code would be
 * worse than no code at all in a handoff that says "the tests ran and
 * failed".
 *
 * Both places it is used hand it a free-form tool result: pi's
 * `tool_execution_end.result` and ACP's `tool_call_update.rawOutput`. Neither
 * protocol promises the field; where it is absent, nothing is set.
 */
export function exitCodeFrom(value: unknown): number | undefined {
  const direct = readCode(value)
  if (direct !== undefined) return direct
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  // Harnesses commonly wrap the payload once ({ success: { exitCode } }).
  const record = value as Record<string, unknown>
  for (const key of ["success", "result", "output", "value", "data"]) {
    const nested = readCode(record[key])
    if (nested !== undefined) return nested
  }
  return undefined
}

function readCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ["exitCode", "exit_code", "exitStatus", "exit_status"]) {
    const code = record[key]
    if (typeof code === "number" && Number.isInteger(code)) return code
  }
  return undefined
}
