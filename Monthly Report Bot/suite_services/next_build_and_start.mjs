// NeraVeda: build a Next.js web app, then serve the build (`next start`).
//
//   node next_build_and_start.mjs <path to next/dist/bin/next> [next start options…]     (cwd = the app folder)
//
// Used by the launcher when the app's sources are newer than its last build. The production server has no file
// watcher, so OneDrive touching files in the app folder can never make the page reload (it did with `next dev`).
// If the build fails, the app is served in development mode instead, so the workspace still opens; the build's
// output and the reason are in the server log (this process's stdout).

import { spawn, spawnSync } from "node:child_process"
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const [nextBin, ...options] = process.argv.slice(2)
if (!nextBin) {
  console.error("usage: node next_build_and_start.mjs <next bin> [options]")
  process.exit(2)
}

// The app folder is inside OneDrive, which may be syncing the previous build's files at the moment Next.js clears
// them; Windows then refuses the delete (EPERM / EBUSY) and the build fails. So the old output is cleared here first,
// retrying while OneDrive holds a file, and a failed build is retried once. The compiler cache and the development
// server's folder are kept.
const KEEP = new Set(["cache", "dev"])

function clearPreviousBuild() {
  let entries = []
  try {
    entries = readdirSync(".next")
  } catch {
    return
  }
  for (const name of entries) {
    if (KEEP.has(name)) continue
    try {
      rmSync(join(".next", name), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
    } catch (error) {
      console.error(`[neraveda] could not clear .next/${name} (${error.code ?? error.message}); the build will try anyway`)
    }
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function build() {
  clearPreviousBuild()
  return spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env: process.env })
}

const started = Date.now()
console.log("[neraveda] building the app (sources changed since the last build)…")
let result = build()
if (result.status !== 0) {
  console.error(`[neraveda] build failed (exit ${result.status ?? result.signal}); waiting for OneDrive, then trying once more…`)
  pause(5000)
  result = build()
}
let mode = "start"
if (result.status === 0) {
  console.log(`[neraveda] build finished in ${Math.round((Date.now() - started) / 1000)} s; starting the production server`)
} else {
  // Last resort only: development mode reloads the page when OneDrive touches files.
  mode = "dev"
  console.error(`[neraveda] build failed again (exit ${result.status ?? result.signal}); starting in development mode instead`)
}

const server = spawn(process.execPath, [nextBin, mode, ...options], { stdio: "inherit", env: process.env })
const stop = () => server.kill()
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
