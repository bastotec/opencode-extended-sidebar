import { firstmateCommandEnv, type FirstmateConfiguration } from "./pware.oc.firstmate.discovery.js"

export const FIRSTMATE_STDOUT_LIMIT = 4 * 1024 * 1024
export const FIRSTMATE_STDERR_LIMIT = 16 * 1024
export const FIRSTMATE_DEADLINE_MS = 20_000
const TERM_GRACE_MS = 250
const KILL_SETTLE_MS = 250
const EXIT_OBSERVE_SETTLE_MS = 25

export type FirstmateCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  reason: "ok" | "nonzero" | "timeout" | "cancelled" | "oversized" | "malformed" | "spawn"
}

type Configured = Extract<FirstmateConfiguration, { configured: true }>
type Collector = { promise: Promise<string>; cancel: () => Promise<void> }
export type FirstmateDirectChild = {
  exitCode: number | null
  kill: (signal: NodeJS.Signals) => void
}

function collector(stream: ReadableStream<Uint8Array> | null, limit: number, exceeded: () => void): Collector {
  if (!stream) return { promise: Promise.resolve(""), cancel: async () => {} }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  let size = 0
  const promise = (async () => {
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > limit) {
          exceeded()
          break
        }
        out += decoder.decode(part.value, { stream: true })
      }
    } catch {
      // Termination and cancellation may reject a pending stream read.
    }
    return out + decoder.decode()
  })()
  return {
    promise,
    cancel: async () => {
      try { await reader.cancel() } catch { /* already closed */ }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createDirectChildTerminator(
  child: FirstmateDirectChild,
  exited: Promise<unknown>,
  exitObserved: () => boolean,
  graceMs = TERM_GRACE_MS,
): () => Promise<void> {
  let termination: Promise<void> | null = null
  return () => {
    if (termination) return termination
    termination = (async () => {
      if (exitObserved() || child.exitCode !== null) return
      try { child.kill("SIGTERM") } catch { return }
      await Promise.race([exited.then(() => undefined), sleep(graceMs)])
      if (exitObserved() || child.exitCode !== null) return
      try { child.kill("SIGKILL") } catch { return }
      await Promise.race([exited.then(() => undefined), sleep(KILL_SETTLE_MS)])
    })()
    return termination
  }
}

export async function runFirstmateCommand(
  config: Configured,
  options: { signal?: AbortSignal; deadlineMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<FirstmateCommandResult> {
  if (options.signal?.aborted) return { ok: false, stdout: "", stderr: "", exitCode: null, reason: "cancelled" }
  let child: ReturnType<typeof Bun.spawn>
  let exitObserved = false
  try {
    child = Bun.spawn([config.executable, "--json"], {
      env: firstmateCommandEnv(config, options.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      onExit: () => { exitObserved = true },
    })
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Firstmate command failed",
      exitCode: null,
      reason: "spawn",
    }
  }

  let trigger: "timeout" | "cancelled" | "oversized" | null = null
  let resolveTrigger!: (reason: "timeout" | "cancelled" | "oversized") => void
  const triggered = new Promise<"timeout" | "cancelled" | "oversized">((resolve) => { resolveTrigger = resolve })
  const setTrigger = (reason: "timeout" | "cancelled" | "oversized"): void => {
    if (trigger) return
    trigger = reason
    resolveTrigger(reason)
  }
  const stdout = collector(child.stdout as ReadableStream<Uint8Array>, FIRSTMATE_STDOUT_LIMIT, () => setTrigger("oversized"))
  const stderr = collector(child.stderr as ReadableStream<Uint8Array>, FIRSTMATE_STDERR_LIMIT, () => setTrigger("oversized"))
  const exited = child.exited.then(
    (code) => { exitObserved = true; return code },
    () => { exitObserved = true; return null },
  )
  const terminate = createDirectChildTerminator(child, exited, () => exitObserved)
  const complete = Promise.all([stdout.promise, stderr.promise, exited]).then(([out, err, code]) => ({ out, err, code }))
  const abort = (): void => setTrigger("cancelled")
  options.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => setTrigger("timeout"), options.deadlineMs ?? FIRSTMATE_DEADLINE_MS)
  timer.unref?.()

  const first = await Promise.race([
    complete.then((value) => ({ kind: "complete" as const, value })),
    triggered.then((reason) => ({ kind: "trigger" as const, reason })),
  ])
  clearTimeout(timer)
  options.signal?.removeEventListener("abort", abort)
  if (first.kind === "complete") {
    const { out, err, code } = first.value
    if (code !== 0) return { ok: false, stdout: out, stderr: err, exitCode: code, reason: "nonzero" }
    return { ok: true, stdout: out, stderr: err, exitCode: code, reason: "ok" }
  }

  await Promise.race([Promise.all([stdout.cancel(), stderr.cancel()]), sleep(KILL_SETTLE_MS)])
  // Closing inherited pipes lets Bun publish an already-exited direct child
  // before termination is considered. Descendants are never inspected or hit.
  await Promise.race([exited.then(() => undefined), sleep(EXIT_OBSERVE_SETTLE_MS)])
  await terminate()
  await Promise.race([exited.then(() => undefined), sleep(KILL_SETTLE_MS)])
  const [out, err] = await Promise.all([
    Promise.race([stdout.promise, sleep(KILL_SETTLE_MS).then(() => "")]),
    Promise.race([stderr.promise, sleep(KILL_SETTLE_MS).then(() => "")]),
  ])
  const code = child.exitCode
  return { ok: false, stdout: out, stderr: err, exitCode: code, reason: first.reason }
}
