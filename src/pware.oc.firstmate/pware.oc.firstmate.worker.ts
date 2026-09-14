/**
 * pware.oc.firstmate.worker
 *
 * Parses and normalizes a `fm-fleet-snapshot.v1` payload off the TUI main
 * thread. A Bun Worker receiving `{type:"firstmate", id, stdout, home, root}`
 * replies `{type:"firstmate:done", id, ok, snapshot}`; `{type:"shutdown"}`
 * closes the worker. The normalizer runs unchanged in this thread, so the unit
 * test surface stays intact.
 */
import { normalizeFirstmate } from "./pware.oc.firstmate.normalize.js"

type NormalizeRequest = {
  type: "firstmate"
  id: number
  stdout: string
  home: string
  root: string
}

type ShutdownRequest = { type: "shutdown" }

type WorkerScope = {
  onmessage: ((event: MessageEvent<NormalizeRequest | ShutdownRequest>) => void) | null
  postMessage: (message: unknown) => void
  close: () => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  const msg = event.data
  if (msg.type === "shutdown") {
    scope.close()
    return
  }
  try {
    const snapshot = normalizeFirstmate(JSON.parse(msg.stdout), msg.home, msg.root)
    scope.postMessage({ type: "firstmate:done", id: msg.id, ok: true, snapshot })
  } catch (err) {
    scope.postMessage({
      type: "firstmate:done",
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
