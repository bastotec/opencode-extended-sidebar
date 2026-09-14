import { discoverFirstmate, type FirstmateConfiguration } from "./pware.oc.firstmate.discovery.js"
import { runFirstmateCommand, type FirstmateCommandResult } from "./pware.oc.firstmate.command.js"
import { normalizeFirstmate } from "./pware.oc.firstmate.normalize.js"
import { unavailableFirstmate, type FirstmateSnapshot } from "./pware.oc.firstmate.model.js"

export const FIRSTMATE_POLL_MS = 30_000

export type FirstmatePollerHandle = {
  stop: () => void
}

type Configured = Extract<FirstmateConfiguration, { configured: true }>

function failureSnapshot(config: Configured, result: FirstmateCommandResult, lastGood: FirstmateSnapshot | null): FirstmateSnapshot {
  const stderr = result.stderr.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_024)
  const detail = stderr ? `: ${stderr}` : ""
  const diagnostic = `Firstmate snapshot ${result.reason}${detail}`
  if (lastGood?.home === config.home) {
    const diagnostics = [...lastGood.diagnostic, diagnostic]
    return {
      ...lastGood,
      freshness: "stale",
      diagnostic: diagnostics.slice(Math.max(0, diagnostics.length - 256)),
      workItems: lastGood.workItems.map((item) => ({ ...item, freshness: "stale" })),
    }
  }
  return unavailableFirstmate(config.home, config.root, diagnostic)
}

export type FirstmatePollerOptions = {
  env?: NodeJS.ProcessEnv
  pollMs?: number
  onSnapshot: (snapshot: FirstmateSnapshot) => void
  run?: (config: Configured, options: { signal: AbortSignal }) => Promise<FirstmateCommandResult>
  configuration?: FirstmateConfiguration
}

export function startFirstmatePoller(options: FirstmatePollerOptions): FirstmatePollerHandle | null {
  const config = options.configuration ?? discoverFirstmate(options.env)
  if (!config.configured) return null
  if (config.diagnostic) {
    options.onSnapshot(unavailableFirstmate(config.home, config.root, config.diagnostic))
    return { stop: () => {} }
  }

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let lastGood: FirstmateSnapshot | null = null
  const run = options.run ?? ((cfg, runOptions) => runFirstmateCommand(cfg, runOptions))

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(invoke, options.pollMs ?? FIRSTMATE_POLL_MS)
    timer.unref?.()
  }
  const invoke = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = null
    controller = new AbortController()
    void run(config, { signal: controller.signal }).then((result) => {
      if (stopped) return
      let snapshot: FirstmateSnapshot
      if (!result.ok) {
        snapshot = failureSnapshot(config, result, lastGood)
      } else {
        try {
          snapshot = normalizeFirstmate(JSON.parse(result.stdout), config.home, config.root)
          lastGood = snapshot
        } catch (error) {
          snapshot = failureSnapshot(config, {
            ...result,
            ok: false,
            reason: "malformed",
            stderr: error instanceof Error ? error.message : "Malformed Firstmate snapshot",
          }, lastGood)
        }
      }
      if (snapshot.availability === "available") lastGood = snapshot
      options.onSnapshot(snapshot)
    }).catch((error) => {
      if (!stopped) {
        const snapshot = failureSnapshot(config, {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : "Firstmate read failed",
        exitCode: null,
        reason: "spawn",
        }, lastGood)
        if (snapshot.availability === "available") lastGood = snapshot
        options.onSnapshot(snapshot)
      }
    }).finally(() => {
      controller = null
      if (stopped) return
      schedule()
    })
  }

  invoke()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      controller?.abort()
    },
  }
}
