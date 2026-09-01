/**
 * How a system block reaches a backend that has no system role.
 *
 * The CLI harnesses (`cursor-agent`, `pi`, ACP) take exactly one string per
 * turn — `args.push("--", prompt)` — so anything the app wants to say out of
 * band has to ride in front of the prompt. The fence keeps it legible as
 * context rather than as something the user typed, which matters because the
 * agent's own answer will otherwise start explaining the memory back at them.
 *
 * Providers that do have a system role (Ollama) ignore this and pass
 * `options.system` through properly.
 */
export function withSystemPrefix(prompt: string, system?: string) {
  const block = system?.trim()
  if (!block) return prompt
  return `<context>\n${block}\n</context>\n\n${prompt}`
}
