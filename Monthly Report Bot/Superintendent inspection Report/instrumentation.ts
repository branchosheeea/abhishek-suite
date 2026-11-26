// Runs once when the NeraVeda web server starts (Next.js instrumentation hook).
// Guarantee Claim Manager: start the Python helper so its background Outlook sync runs while this server runs, even
// before anyone opens a Guarantee Claims page. Only on the real server (it has the web secret), never during a build,
// and without delaying the server: the helper starts in the background and a failure is only logged.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.NERAVEDA_WEB_SECRET || process.env.NEXT_PHASE === "phase-production-build") return
  const { gcHelper } = await import("./lib/gc/helper")
  gcHelper().call("ping").catch((error: unknown) => console.error("[gc-helper] could not start for background Outlook sync:", error instanceof Error ? error.message : error))
}
