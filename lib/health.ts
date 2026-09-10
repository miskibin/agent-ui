/** The response the desktop sidecar uses to establish Next.js readiness. */
export function healthResponse(token: string | undefined): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
      ...(token ? { "x-agent-ui-launch": token } : null),
    },
  })
}
