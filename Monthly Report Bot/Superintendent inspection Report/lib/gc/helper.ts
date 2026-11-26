// Guarantee Claim Manager: the bridge from this web server to the Python claim helper (gc_manager/service.py).
//
// The Python Repository stays the only place that reads or changes claims. This server starts the helper as its own
// child process and talks to it over stdin/stdout, one JSON object per line: no port, so nothing else on the PC can
// reach it. Every /api/gc route checks the NeraVeda session and the "gc" right first (route({ module: GC_MODULE })).
//
// Supervision:
// - started on first use; one helper per server (globalThis), like the Digital Docking store;
// - every call has a time limit; on timeout the helper is stopped and the next call starts a new one
//   (a write cut off half-way is rolled back by SQLite, because every Repository write is one transaction);
// - if it exits, waiting calls fail with 503 and the next call starts it again; after 3 starts within a minute
//   it is left stopped for 30 s, so a broken installation cannot spin;
// - it ends with this server: the launcher stops the whole process tree (taskkill /T), and the helper also exits
//   by itself when its stdin closes.
// Server-side only.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { AppError } from "../server/errors"

export const GC_MODULE = "gc"
export const READ_LIMIT: [string, number] = ["gc-read", 600]
/** Changes (Phase 4): a person confirming a register works well under this; a runaway script does not. */
export const WRITE_LIMIT: [string, number] = ["gc-write", 120]

/** Environment variables for the helper (a plain map: Next.js types make NodeJS.ProcessEnv require NODE_ENV). */
export type Env = Record<string, string | undefined>

export type HelperOptions = {
  command: string
  args: string[]
  cwd: string
  env?: Env
  /** Per call, in milliseconds. */
  timeoutMs?: number
  /** Restart guard: this many starts within windowMs → refuse for coolDownMs. */
  maxStarts?: number
  windowMs?: number
  coolDownMs?: number
  log?: (line: string) => void
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** HTTP status for each error kind the helper reports. */
const KIND_STATUS: Record<string, number> = { bad_request: 400, validation: 400, not_found: 404, conflict: 409, unavailable: 503, internal: 500 }
const SAFE_INTERNAL = "Internal error. Details are in the server log."
const MAX_REPLY_CHARS = 64 * 1024 * 1024

export class GcHelper {
  private readonly options: Required<Omit<HelperOptions, "env">> & { env?: Env }
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ""
  private starts: number[] = []
  private refusedUntil = 0

  constructor(options: HelperOptions) {
    this.options = {
      timeoutMs: 30_000, maxStarts: 3, windowMs: 60_000, coolDownMs: 30_000,
      log: (line) => console.error(`[gc-helper] ${line}`), ...options,
    }
  }

  /** True while a helper process is running. */
  get running(): boolean {
    return this.child !== null
  }

  call<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    let child: ChildProcess
    try {
      child = this.ensure()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextId++
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new AppError(504, "The claim service did not answer in time. Try again."))
        this.options.log(`no answer to "${cmd}" within ${this.options.timeoutMs} ms; restarting the helper`)
        this.stop()
      }, this.options.timeoutMs)
      this.pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject: rejectPromise, timer })
      child.stdin!.write(JSON.stringify({ id, cmd, args }) + "\n")
    })
  }

  /** Stop the helper; waiting calls fail with 503. */
  stop(): void {
    const child = this.child
    this.child = null
    this.buffer = ""
    if (child && child.exitCode === null) child.kill()
    this.failAll(new AppError(503, "The claim service stopped. Try again."))
  }

  private ensure(): ChildProcess {
    if (this.child) return this.child
    const now = Date.now()
    if (now < this.refusedUntil) throw new AppError(503, "The claim service keeps stopping. Details are in the server log; try again shortly.")
    this.starts = this.starts.filter((t) => now - t < this.options.windowMs)
    if (this.starts.length >= this.options.maxStarts) {
      this.refusedUntil = now + this.options.coolDownMs
      this.starts = []
      this.options.log(`started ${this.options.maxStarts} times within ${this.options.windowMs} ms; pausing ${this.options.coolDownMs} ms`)
      throw new AppError(503, "The claim service keeps stopping. Details are in the server log; try again shortly.")
    }
    this.starts.push(now)
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env as NodeJS.ProcessEnv | undefined, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    this.child = child
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => this.receive(child, chunk))
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.options.log(line)
    })
    child.stdin!.on("error", () => undefined) // a closed pipe is reported through "exit"
    child.on("error", (error) => {
      this.options.log(`could not start: ${error.message}`)
      this.ended(child, new AppError(503, "The claim service could not start. Details are in the server log."))
    })
    child.on("exit", (code, signal) => {
      if (this.child === child) this.options.log(`stopped (exit ${code ?? signal})`)
      this.ended(child, new AppError(503, "The claim service stopped. Try again."))
    })
    return child
  }

  private ended(child: ChildProcess, error: AppError): void {
    if (this.child !== child) return
    this.child = null
    this.buffer = ""
    this.failAll(error)
  }

  private failAll(error: AppError): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      this.pending.delete(id)
      waiting.reject(error)
    }
  }

  private receive(child: ChildProcess, chunk: string): void {
    if (this.child !== child) return
    this.buffer += chunk
    if (this.buffer.length > MAX_REPLY_CHARS) {
      this.options.log("reply too large; restarting the helper")
      this.stop()
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.settle(line)
    }
  }

  private settle(line: string): void {
    let reply: { id?: unknown; ok?: unknown; result?: unknown; error?: { kind?: unknown; message?: unknown }; event?: unknown }
    try {
      reply = JSON.parse(line)
    } catch {
      this.options.log("ignored a line that is not JSON")
      return
    }
    if (reply.event !== undefined || typeof reply.id !== "number") return // "ready" and replies without an id
    const waiting = this.pending.get(reply.id)
    if (!waiting) return // answered after its time limit
    this.pending.delete(reply.id)
    clearTimeout(waiting.timer)
    if (reply.ok === true) {
      waiting.resolve(reply.result)
      return
    }
    const kind = typeof reply.error?.kind === "string" ? reply.error.kind : "internal"
    const status = KIND_STATUS[kind] ?? 500
    const message = status === 500 || typeof reply.error?.message !== "string" ? SAFE_INTERNAL : reply.error.message
    waiting.reject(new AppError(status, message))
  }
}

/** Where the NeraVeda project is (the folder holding gc_manager/), and which Python to run. */
export function helperOptions(env: Env = process.env): HelperOptions {
  const root = env.NERAVEDA_PROJECT_ROOT || resolve(process.cwd(), "..")
  if (!existsSync(join(root, "gc_manager", "service.py"))) throw new AppError(503, "Guarantee Claim Manager was not found next to this app.")
  const venv = join(root, ".venv", "Scripts", "python.exe")
  const command = env.NERAVEDA_PYTHON || (existsSync(venv) ? venv : "python")
  // The helper needs the Suite's data folder and Outlook settings, not this server's secrets.
  // GC_AUTO_SYNC: the helper syncs Outlook in the background only under the real NeraVeda web server (it has the web
  // secret); tests and scripts get no background sync unless they ask for it.
  const childEnv: Env = { ...env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", GC_AUTO_SYNC: env.GC_AUTO_SYNC ?? (env.NERAVEDA_WEB_SECRET ? "1" : "0") }
  for (const key of Object.keys(childEnv)) if (key === "NERAVEDA_WEB_SECRET" || /MONGODB|_URI$/i.test(key)) delete childEnv[key]
  return { command, args: ["-m", "gc_manager.service"], cwd: root, env: childEnv }
}

const state = globalThis as unknown as { __gcHelper?: GcHelper }

/** The one helper this server uses (started on first call). */
export function gcHelper(): GcHelper {
  state.__gcHelper ??= new GcHelper(helperOptions())
  return state.__gcHelper
}
