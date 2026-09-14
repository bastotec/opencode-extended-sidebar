import { describe, expect, test } from "bun:test"
import { createEventBus } from "../../../src/pware.oc.core/pware.oc.core.bus.js"
import {
  EV_OES_REFRESH_HINT,
  EV_OES_SNAPSHOT,
} from "../../../src/pware.oc.core/constants/pware.oc.core.constants.eventName.js"
import { unavailableFirstmate } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.model.js"
import { startRuntimeSource, withFirstmateSnapshot } from "../../../src/pware.oc.runtime/pware.oc.runtime.source.js"
import type { RuntimeSnapshot } from "../../../src/pware.oc.runtime/resolver/index.js"

function host(sessionId: string, error: string | null = null): RuntimeSnapshot {
  return {
    generatedAt: 1,
    fingerprint: sessionId,
    scanStamp: "db",
    db: { present: error === null, error, recent: [] },
    omo: { marker: "preserved" },
    omoConfig: { marker: "preserved" },
    delegates: [],
    openQuestions: [],
  } as unknown as RuntimeSnapshot
}

describe("Firstmate runtime source composition", () => {
  test("publishes additive fleet updates without replacing host data", () => {
    const runtime = host("one", "db read failed")
    const firstmate = unavailableFirstmate("/tmp/home", "/tmp/root")
    const merged = withFirstmateSnapshot(runtime, firstmate)
    expect(merged.db).toBe(runtime.db)
    expect(merged.omo).toBe(runtime.omo)
    expect(merged.firstmate).toBe(firstmate)
    expect(withFirstmateSnapshot(runtime, null)).toBe(runtime)
  })

  test("starts fleet once, isolates host refreshes, preserves it across sessions, and stops both", async () => {
    const bus = createEventBus()
    const published: RuntimeSnapshot[] = []
    bus.on(EV_OES_SNAPSHOT, (event) => published.push((event.data as { snapshot: RuntimeSnapshot }).snapshot))
    let fleetStarts = 0
    let fleetStops = 0
    let monitorRefreshes = 0
    let monitorStops = 0
    const sessions: string[] = []
    const source = startRuntimeSource({
      bus,
      sessionId: "one",
      projectRoot: null,
      monitorFactory: (options) => {
        sessions.push(options.sessionId)
        options.onChange?.(host(options.sessionId, options.sessionId === "two" ? "db read failed" : null))
        return {
          refresh: () => { monitorRefreshes++ },
          question: () => {},
          stop: () => { monitorStops++ },
        }
      },
      firstmatePollerFactory: (options) => {
        fleetStarts++
        options.onSnapshot(unavailableFirstmate("/tmp/home", "/tmp/root"))
        return { stop: () => { fleetStops++ } }
      },
    })

    expect(fleetStarts).toBe(1)
    expect(published.at(-1)?.firstmate?.home).toBe("/tmp/home")
    source.refresh()
    expect(monitorRefreshes).toBe(1)
    bus.emit({ type: EV_OES_REFRESH_HINT, ts: Date.now() })
    await Bun.sleep(120)
    expect(monitorRefreshes).toBe(2)
    expect(fleetStarts).toBe(1)
    source.setSession("two")
    expect(sessions).toEqual(["one", "two"])
    expect(fleetStarts).toBe(1)
    expect(published.at(-1)?.db.error).toBe("db read failed")
    expect(published.at(-1)?.firstmate?.home).toBe("/tmp/home")
    source.stop()
    expect(monitorStops).toBe(2)
    expect(fleetStops).toBe(1)
  })
})
