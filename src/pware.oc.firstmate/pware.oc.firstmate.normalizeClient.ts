/**
 * pware.oc.firstmate.normalizeClient
 *
 * Async facade over the Firstmate normalize worker. `normalizeFirstmateAsync`
 * posts a raw `fm-fleet-snapshot.v1` payload and resolves with the normalized
 * snapshot; when the worker cannot be spawned, errors, or fails to answer
 * within the timeout it normalizes in the host process instead. A payload the
 * normalizer rejects always rejects here, whichever thread parsed it.
 */
import { dbg } from "../pware.oc.core/pware.oc.core.debug.js"
import { normalizeFirstmate } from "./pware.oc.firstmate.normalize.js"
import type { FirstmateSnapshot } from "./pware.oc.firstmate.model.js"

type NormalizeDoneMessage = {
  type: "firstmate:done"
  id: number
  ok: boolean
  snapshot?: FirstmateSnapshot
  error?: string
}

/** Bound on a single worker round-trip before the host path takes over. */
const WORKER_TIMEOUT_MS = 4_000

type PendingEntry = {
  request: { stdout: string; home: string; root: string }
  resolve: (snapshot: FirstmateSnapshot) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let worker: Worker | null = null
let workerFailed = false
let nextId = 0
const pending = new Map<number, PendingEntry>()

function hostNormalize(request: { stdout: string; home: string; root: string }): FirstmateSnapshot {
  return normalizeFirstmate(JSON.parse(request.stdout), request.home, request.root)
}

function take(id: number): PendingEntry | null {
  const entry = pending.get(id)
  if (!entry) return null
  pending.delete(id)
  clearTimeout(entry.timer)
  return entry
}

function settleOnHost(id: number): void {
  const entry = take(id)
  if (!entry) return
  try {
    entry.resolve(hostNormalize(entry.request))
  } catch (err) {
    entry.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

function failAll(reason: string): void {
  dbg("firstmate.worker", "failed", { reason })
  workerFailed = true
  for (const id of [...pending.keys()]) settleOnHost(id)
}

function ensureWorker(): Worker | null {
  if (workerFailed) return null
  if (worker) return worker
  try {
    const w = new Worker(new URL("./pware.oc.firstmate.worker.ts", import.meta.url), { type: "module" })
    w.onmessage = (event: MessageEvent<NormalizeDoneMessage>) => {
      const msg = event.data
      if (!msg || msg.type !== "firstmate:done") return
      const entry = take(msg.id)
      if (!entry) return
      if (msg.ok && msg.snapshot) entry.resolve(msg.snapshot)
      else entry.reject(new Error(msg.error ?? "Malformed Firstmate snapshot"))
    }
    w.onerror = (event) => {
      const message =
        typeof event === "object" && event !== null && "message" in event
          ? String((event as { message: unknown }).message)
          : String(event)
      failAll(message)
      try {
        w.terminate()
      } catch {
        // ignore
      }
      worker = null
    }
    ;(w as Worker & { unref?: () => void }).unref?.()
    worker = w
    dbg("firstmate.worker", "spawned", {})
    return w
  } catch (err) {
    dbg("firstmate.worker", "spawn failed", { error: err instanceof Error ? err.message : String(err) })
    workerFailed = true
    return null
  }
}

export function normalizeFirstmateAsync(stdout: string, home: string, root: string): Promise<FirstmateSnapshot> {
  const request = { stdout, home, root }
  const w = ensureWorker()
  if (!w) {
    try {
      return Promise.resolve(hostNormalize(request))
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }
  const id = ++nextId
  return new Promise<FirstmateSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => settleOnHost(id), WORKER_TIMEOUT_MS)
    timer.unref?.()
    pending.set(id, { request, resolve, reject, timer })
    try {
      w.postMessage({ type: "firstmate", id, ...request })
    } catch (err) {
      dbg("firstmate.worker", "post failed", { error: err instanceof Error ? err.message : String(err) })
      settleOnHost(id)
    }
  })
}

/** Terminate the shared worker (idempotent). Safe to call on plugin shutdown. */
export function shutdownFirstmateWorker(): void {
  if (!worker) return
  try {
    worker.postMessage({ type: "shutdown" })
  } catch {
    // ignore
  }
  try {
    worker.terminate()
  } catch {
    // ignore
  }
  worker = null
}
