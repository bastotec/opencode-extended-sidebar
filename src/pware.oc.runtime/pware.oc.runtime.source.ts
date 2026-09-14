import type { PwareEventBus } from "../pware.oc.core/pware.oc.core.bus.js"
import { EVENT_SCAN_DEBOUNCE_MS } from "../pware.oc.core/pware.oc.core.timing.js"
import {
  EV_OES_QUESTION_HINT,
  EV_OES_REFRESH_HINT,
  EV_OES_SNAPSHOT,
} from "../pware.oc.core/constants/pware.oc.core.constants.eventName.js"
import {
  EV_OMO_BOULDER_CHANGED,
  EV_OMO_CONFIG_CHANGED,
  EV_OMO_DOCS_CHANGED,
} from "../pware.oc.omo/constants/pware.oc.omo.constants.eventName.js"
import { startMonitor, type MonitorHandle } from "./pware.oc.runtime.monitor.js"
import { shutdownSnapshotWorker } from "./pware.oc.runtime.snapshotClient.js"
import { shutdownFirstmateWorker } from "../pware.oc.firstmate/pware.oc.firstmate.normalizeClient.js"
import {
  startFirstmatePoller,
  type FirstmatePollerHandle,
  type FirstmatePollerOptions,
} from "../pware.oc.firstmate/pware.oc.firstmate.poller.js"
import type { FirstmateSnapshot } from "../pware.oc.firstmate/pware.oc.firstmate.model.js"
import type { RuntimeSnapshot } from "./resolver/index.js"

export type RuntimeSourceOptions = {
  bus: PwareEventBus
  sessionId: string
  projectRoot: string | null
  dbPath?: string
  pollMs?: number
  monitorFactory?: (options: Parameters<typeof startMonitor>[0]) => MonitorHandle
  firstmatePollerFactory?: (options: FirstmatePollerOptions) => FirstmatePollerHandle | null
}

export type RuntimeSourceHandle = {
  stop: () => void
  refresh: () => void
  setSession: (sessionId: string) => void
}

export function withFirstmateSnapshot(
  host: RuntimeSnapshot,
  firstmate: FirstmateSnapshot | null,
): RuntimeSnapshot {
  return firstmate ? { ...host, firstmate } : host
}

export function startRuntimeSource(opts: RuntimeSourceOptions): RuntimeSourceHandle {
  let stopped = false
  let watchedSessionId = opts.sessionId
  let debounce: ReturnType<typeof setTimeout> | null = null
  let questionDebounce: ReturnType<typeof setTimeout> | null = null
  let pendingQuestionSession: string | null = null
  let hostSnapshot: RuntimeSnapshot | null = null
  let firstmateSnapshot: FirstmateSnapshot | null = null

  const publish = (): void => {
    if (stopped || !hostSnapshot) return
    const snapshot = withFirstmateSnapshot(hostSnapshot, firstmateSnapshot)
    opts.bus.emit({ type: EV_OES_SNAPSHOT, ts: Date.now(), data: { snapshot } })
  }

  const bindMonitor = (sessionId: string): MonitorHandle =>
    (opts.monitorFactory ?? startMonitor)({
      sessionId,
      projectRoot: opts.projectRoot,
      dbPath: opts.dbPath,
      pollMs: opts.pollMs,
      onChange: (snapshot) => {
        hostSnapshot = snapshot
        publish()
      },
      onBoulderChange: () => opts.bus.emit({ type: EV_OMO_BOULDER_CHANGED, ts: Date.now(), data: {} }),
    })

  let monitor = bindMonitor(watchedSessionId)
  const firstmate: FirstmatePollerHandle | null = (opts.firstmatePollerFactory ?? startFirstmatePoller)({
    onSnapshot: (snapshot) => {
      firstmateSnapshot = snapshot
      publish()
    },
  })

  const scheduleRefresh = (): void => {
    if (stopped) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      monitor.refresh()
    }, EVENT_SCAN_DEBOUNCE_MS)
  }

  const scheduleQuestionHint = (sessionId: string): void => {
    if (stopped) return
    pendingQuestionSession = sessionId
    if (questionDebounce) clearTimeout(questionDebounce)
    questionDebounce = setTimeout(() => {
      questionDebounce = null
      const sid = pendingQuestionSession
      pendingQuestionSession = null
      if (sid) monitor.question(sid)
    }, EVENT_SCAN_DEBOUNCE_MS)
  }

  const offRefreshHint = opts.bus.on(EV_OES_REFRESH_HINT, scheduleRefresh)
  const offQuestionHint = opts.bus.on(EV_OES_QUESTION_HINT, (evt) => {
    const data = evt.data as { sessionId?: string } | null | undefined
    if (data?.sessionId) scheduleQuestionHint(data.sessionId)
  })
  const offBoulderChanged = opts.bus.on(EV_OMO_BOULDER_CHANGED, scheduleRefresh)
  const offDocsChanged = opts.bus.on(EV_OMO_DOCS_CHANGED, scheduleRefresh)
  const offConfigChanged = opts.bus.on(EV_OMO_CONFIG_CHANGED, scheduleRefresh)

  return {
    refresh: () => monitor.refresh(),
    setSession: (sessionId: string) => {
      if (!sessionId || sessionId === watchedSessionId) return
      watchedSessionId = sessionId
      hostSnapshot = null
      if (debounce) {
        clearTimeout(debounce)
        debounce = null
      }
      monitor.stop()
      monitor = bindMonitor(sessionId)
    },
    stop: () => {
      stopped = true
      if (debounce) clearTimeout(debounce)
      debounce = null
      if (questionDebounce) clearTimeout(questionDebounce)
      questionDebounce = null
      pendingQuestionSession = null
      offRefreshHint()
      offQuestionHint()
      offBoulderChanged()
      offDocsChanged()
      offConfigChanged()
      monitor.stop()
      firstmate?.stop()
      shutdownFirstmateWorker()
      shutdownSnapshotWorker()
    },
  }
}
