/** Hosted credentials are a fallback only for the built-in dsh agent. */
export function hasDeepSeekCredentials(agent: {
  kind: "dsh" | "generic"
  dsh: { apiKey: string }
}): boolean {
  return (
    agent.kind === "dsh" &&
    Boolean(agent.dsh.apiKey.trim() || process.env.DEEPSEEK_API_KEY)
  )
}
