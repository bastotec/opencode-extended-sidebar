import { describe, expect, test } from "bun:test"
import { startFirstmatePoller } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.poller.js"
import type { FirstmateSnapshot } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.model.js"

const config = {
  configured: true as const,
  home: "/tmp/fm-home",
  root: "/tmp/fm-root",
  executable: "/tmp/fm-root/bin/fm-fleet-snapshot.sh",
  diagnostic: null,
}

const good = await Bun.file(new URL("../../fixtures/firstmate/fleet.json", import.meta.url)).text()
const degraded = await Bun.file(new URL("../../fixtures/firstmate/fleet-degraded.json", import.meta.url)).text()

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check() && Date.now() < deadline) await Bun.sleep(1)
}

describe("startFirstmatePoller", () => {
  test("absent home is fully disabled and causes zero commands", () => {
    let calls = 0
    const handle = startFirstmatePoller({
      configuration: { configured: false },
      onSnapshot: () => {},
      run: async () => {
        calls++
        throw new Error("must not run")
      },
    })
    expect(handle).toBeNull()
    expect(calls).toBe(0)
  })

  test("retains stale rows for same-home failures and recovers", async () => {
    const snapshots: FirstmateSnapshot[] = []
    let call = 0
    const handle = startFirstmatePoller({
      configuration: config,
      pollMs: 1,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      run: async () => {
        call++
        if (call === 2) return { ok: false, stdout: "", stderr: "unreadable", exitCode: 2, reason: "nonzero" as const }
        return { ok: true, stdout: good, stderr: "", exitCode: 0, reason: "ok" as const }
      },
    })
    await waitFor(() => snapshots.length >= 3)
    expect(snapshots[1]?.freshness).toBe("stale")
    expect(snapshots[1]?.observedAt).toBe(Date.parse("2026-09-13T12:00:00Z"))
    expect(snapshots[1]?.workItems.some((item) => item.taskId === "q1")).toBe(true)
    expect(snapshots[2]?.freshness).toBe("fresh")
    handle?.stop()
  })

  test("structurally invalid success retains stale rows but partial current replaces them", async () => {
    const snapshots: FirstmateSnapshot[] = []
    let call = 0
    const handle = startFirstmatePoller({
      configuration: config,
      pollMs: 1,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      run: async () => {
        call++
        const stdout = call === 1 ? good : call === 2 ? JSON.stringify({ schema: "fm-fleet-snapshot.v1" }) : degraded
        return { ok: true, stdout, stderr: "", exitCode: 0, reason: "ok" as const }
      },
    })
    await waitFor(() => snapshots.length >= 3)
    expect(snapshots[1]?.freshness).toBe("stale")
    expect(snapshots[1]?.workItems.some((item) => item.taskId === "q1")).toBe(true)
    expect(snapshots[2]?.completeness).toBe("partial")
    expect(snapshots[2]?.workItems.map((item) => item.taskId)).toEqual(["partial-queued"])
    handle?.stop()
  })

  test("malformed, timeout, and oversized results degrade without throwing", async () => {
    for (const result of [
      { ok: true, stdout: "{bad", stderr: "", exitCode: 0, reason: "ok" as const },
      { ok: false, stdout: "", stderr: "", exitCode: null, reason: "timeout" as const },
      { ok: false, stdout: "", stderr: "", exitCode: null, reason: "oversized" as const },
    ]) {
      const snapshots: FirstmateSnapshot[] = []
      const handle = startFirstmatePoller({ configuration: config, onSnapshot: (snapshot) => snapshots.push(snapshot), run: async () => result })
      await waitFor(() => snapshots.length === 1)
      expect(snapshots[0]?.availability).toBe("unavailable")
      handle?.stop()
    }
  })

  test("allows only one command in flight and ignores a late result after stop", async () => {
    let calls = 0
    let resolve!: (value: { ok: true; stdout: string; stderr: string; exitCode: 0; reason: "ok" }) => void
    const snapshots: FirstmateSnapshot[] = []
    const handle = startFirstmatePoller({
      configuration: config,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      run: () => {
        calls++
        return new Promise((done) => { resolve = done })
      },
    })
    await Bun.sleep(5)
    expect(calls).toBe(1)
    handle?.stop()
    resolve({ ok: true, stdout: good, stderr: "", exitCode: 0, reason: "ok" })
    await Bun.sleep(5)
    expect(snapshots).toEqual([])
  })
})
