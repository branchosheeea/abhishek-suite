// NeraVeda: build a Next.js web app, then serve the build (`next start`).
//
//   node next_build_and_start.mjs <path to next/dist/bin/next> [next start options…]     (cwd = the app folder)
//
// Used by the launcher when the app's sources are newer than its last build. The production server has no file
// watcher, so OneDrive touching files in the app folder can never make the page reload (it did with `next dev`).
// If the build fails, the app is served in development mode instead, so the workspace still opens; the build's
// output and the reason are in the server log (this process's stdout).

import { spawn, spawnSync } from "node:child_process"

const [nextBin, ...options] = process.argv.slice(2)
if (!nextBin) {
  console.error("usage: node next_build_and_start.mjs <next bin> [options]")
  process.exit(2)
}

const started = Date.now()
console.log("[neraveda] building the app (sources changed since the last build)…")
const build = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env: process.env })
let mode = "start"
if (build.status === 0) {
  console.log(`[neraveda] build finished in ${Math.round((Date.now() - started) / 1000)} s; starting the production server`)
} else {
  mode = "dev"
  console.error(`[neraveda] build failed (exit ${build.status ?? build.signal}); starting in development mode instead`)
}

const server = spawn(process.execPath, [nextBin, mode, ...options], { stdio: "inherit", env: process.env })
const stop = () => server.kill()
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
