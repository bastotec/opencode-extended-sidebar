import { describe, expect, test } from "bun:test"
import { normalizeFirstmate } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.normalize.js"

const fixture = await Bun.file(new URL("../../fixtures/firstmate/fleet.json", import.meta.url)).json()
const degraded = await Bun.file(new URL("../../fixtures/firstmate/fleet-degraded.json", import.meta.url)).json()
const omissionOnly = await Bun.file(new URL("../../fixtures/firstmate/fleet-omission-only.json", import.meta.url)).json()

describe("normalizeFirstmate", () => {
  test("joins canonical main backlog and task metadata without OpenCode sessions", () => {
    const snapshot = normalizeFirstmate(fixture, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.observedAt).toBe(Date.parse("2026-09-13T12:00:00Z"))
    expect(snapshot.workItems.slice(0, 6).map((item) => item.taskId)).toEqual(["q1", "i1", "h1", "b1", "p1", "meta1"])
    expect(snapshot.workItems.slice(0, 6).map((item) => item.harness)).toEqual(["opencode", "codex", "other", null, null, "codex"])
    expect(snapshot.workItems.slice(0, 6).map((item) => item.durableState)).toEqual(["queued", "in_flight", "in_flight", "queued", "in_flight", null])
    expect(snapshot.workItems.find((item) => item.taskId === "h1")).toMatchObject({
      currentRole: "held", holdKind: "captain", holdBucket: "live", captainActionable: true,
    })
    expect(snapshot.workItems.find((item) => item.taskId === "b1")?.unresolvedBlockerIds).toEqual(["dep1"])
    expect(snapshot.workItems.find((item) => item.taskId === "i1")).toMatchObject({
      currentState: "working", currentSource: "pane", currentDetail: "running tests",
      worktree: "/tmp/fm-home/projects/i1",
    })
    expect(snapshot.workItems.find((item) => item.taskId === "meta1")?.warning).toContain("no canonical backlog")
    expect(snapshot.workItems.some((item) => item.taskId === "done1")).toBe(false)
  })

  test("projects nested current secondmate surfaces and deduplicates by child home and id", () => {
    const snapshot = normalizeFirstmate(fixture, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.workItems.filter((item) => item.home === "/srv/mate-a").map((item) => item.taskId)).toEqual([
      "remote-active", "remote-blocked", "remote-decision", "captain-only",
    ])
    expect(snapshot.workItems.find((item) => item.taskId === "remote-active")).toMatchObject({
      durableState: "in_flight", currentState: "working", project: "delta",
      provenanceSelected: "structured-home", provenanceTrust: "complete", ageSeconds: 10,
    })
    expect(snapshot.workItems.find((item) => item.taskId === "remote-blocked")).toMatchObject({
      durableState: "queued", currentRole: "held", holdBucket: "blocked",
    })
    expect(snapshot.workItems.find((item) => item.taskId === "remote-decision")?.decisions?.map((decision) => decision.key)).toEqual(["route", "budget"])
    expect(snapshot.workItems.find((item) => item.taskId === "captain-only")).toMatchObject({
      durableState: null, currentRole: "held", holdKind: "captain", holdBucket: "live",
      holdReason: "approve deployment", captainActionable: true,
      decisions: [{
        key: "captain-only", verb: "captain-hold", reason: "approve deployment",
        holdBucket: "live", holdAgeDays: 1, captainActionable: true,
      }],
    })
  })

  test("keeps identical remote home/task identities separate by host route", () => {
    const routed = structuredClone(fixture)
    const second = structuredClone(routed.secondmate_current.records[0])
    second.id = "mate-b"
    second.host = "host-b"
    routed.secondmate_current.records.push(second)
    routed.secondmate_current.total_registered = 2
    routed.secondmate_current.total = 2
    routed.secondmate_current.shown = 2
    const snapshot = normalizeFirstmate(routed, "/tmp/fm-home", "/tmp/fm-root")
    const duplicated = snapshot.workItems.filter((item) => item.home === "/srv/mate-a" && item.taskId === "remote-active")
    expect(duplicated.map((item) => item.host)).toEqual(["host-a", "host-b"])
    expect(duplicated.every((item) => item.remote === true)).toBe(true)
  })

  test("does not authorize navigation from unknown v1 extension fields", () => {
    const extended = structuredClone(fixture)
    extended.tasks[0].opencode_session_id = "ses_not_canonical"
    extended.tasks[0].navigation = { opencode_session_id: "ses_also_not_canonical" }
    const snapshot = normalizeFirstmate(extended, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.workItems.every((item) => !("sessionId" in item))).toBe(true)
  })

  test("keeps declared and unresolved blockers separate from historical blocked prose", () => {
    const historical = structuredClone(fixture)
    const row = historical.backlog.records.find((entry: { id?: string }) => entry.id === "b1")
    row.unresolved_blocker_ids = []
    row.hold_kind = null
    row.hold_bucket = null
    row.hold_reason = null
    row.blocked_reason = "historical dependency note"
    const snapshot = normalizeFirstmate(historical, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.workItems.find((item) => item.taskId === "b1")).toMatchObject({
      currentRole: "queued",
      holdReason: null,
      holdBucket: null,
      blockedReason: "historical dependency note",
      blockedByIds: ["dep1"],
      unresolvedBlockerIds: [],
      unresolvedBlockers: [],
    })
  })

  test("derives degraded diagnostics, cached freshness, counts, and ledger age", () => {
    const snapshot = normalizeFirstmate(degraded, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.completeness).toBe("partial")
    expect(snapshot.freshness).toBe("stale")
    expect(snapshot.diagnostic.join(" ")).toContain("main inventory")
    expect(snapshot.diagnostic.join(" ")).toContain("registry")
    expect(snapshot.diagnostic.join(" ")).toContain("omitted")
    expect(snapshot.diagnostic.join(" ")).toContain("unreadable")
    const item = snapshot.workItems.find((entry) => entry.taskId === "partial-queued")
    expect(item).toMatchObject({ freshness: "stale", sourceFreshness: "cached", ageSeconds: 3660 })
    expect(item?.homeCounts?.queued).toBe(2)
    expect(snapshot.workItems.some((entry) => entry.home === "/srv/mate-unreadable")).toBe(false)
    expect(snapshot.homes?.find((home) => home.id === "mate-partial")).toMatchObject({
      provenanceSelected: "structured-home", provenanceTrust: "partial-structured",
      summarySource: "remote-ledger-cache", ageSeconds: 3660,
    })
    expect(snapshot.homes?.find((home) => home.id === "mate-unreadable")).toMatchObject({
      currentState: "unknown", provenanceSelected: "parent-event-fallback",
    })
  })

  test("marks a fresh valid snapshot partial for positive per-home omissions", () => {
    const snapshot = normalizeFirstmate(omissionOnly, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.freshness).toBe("fresh")
    expect(snapshot.completeness).toBe("partial")
    expect(snapshot.diagnostic).toContain("secondmate mate-omitted: active_children omitted 2")
  })

  test("degrades malformed nested Secondmate rows and fields without projecting them", () => {
    const malformed = structuredClone(fixture)
    const home = malformed.secondmate_current.records[0]
    home.active_children.push({ id: 42, state: "working" })
    home.queued[0].blocked_by_ids = "remote-dep"
    home.freshness.age_seconds = -1
    home.counts.active_children = 2
    home.counts.queued = 1

    const snapshot = normalizeFirstmate(malformed, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.availability).toBe("available")
    expect(snapshot.completeness).toBe("partial")
    expect(snapshot.workItems.find((item) => item.taskId === "remote-blocked")?.durableState).toBeNull()
    expect(snapshot.homes?.[0]?.provenanceTrust).toBe("partial-structured")
    expect(snapshot.diagnostic.join(" ")).toContain("malformed")
  })

  test("degrades inconsistent Secondmate totals, counts, and omission surfaces", () => {
    const inconsistent = structuredClone(fixture)
    inconsistent.secondmate_current.total_registered = 4
    inconsistent.secondmate_current.shown = 2
    inconsistent.secondmate_current.records[0].counts.holds = 9
    inconsistent.secondmate_current.records[0].omitted = [{ surface: "invented", count: 1 }]

    const snapshot = normalizeFirstmate(inconsistent, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.completeness).toBe("partial")
    expect(snapshot.diagnostic).toContain("secondmate current totals are inconsistent")
    expect(snapshot.diagnostic.join(" ")).toContain("malformed omitted surface")
    expect(snapshot.diagnostic.join(" ")).toContain("holds count 9 does not match 1")
  })

  test("reports unstructured current rows and orphan work even when main claims validity", () => {
    const inconsistent = structuredClone(fixture)
    inconsistent.main_inventory.unstructured_current_count = 2
    inconsistent.main_inventory.orphan_in_flight = [{ id: "orphan-1" }]

    const snapshot = normalizeFirstmate(inconsistent, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.completeness).toBe("partial")
    expect(snapshot.diagnostic.join(" ")).toContain("2 unstructured current rows")
    expect(snapshot.diagnostic.join(" ")).toContain("orphan-1")
  })

  test("preserves stale aggregate freshness when main tasks also include unknown freshness", () => {
    const stale = structuredClone(fixture)
    stale.tasks[0].current_state.freshness = "cached"
    expect(normalizeFirstmate(stale, "/tmp/fm-home", "/tmp/fm-root").freshness).toBe("stale")

    stale.tasks[1].current_state.freshness = "unexpected"
    const snapshot = normalizeFirstmate(stale, "/tmp/fm-home", "/tmp/fm-root")
    expect(snapshot.freshness).toBe("stale")
    expect(snapshot.diagnostic.join(" ")).toContain("main task i1 freshness is unknown")
  })

  test("preserves stale aggregate freshness across stale and unknown Secondmate homes", () => {
    const mixed = structuredClone(fixture)
    mixed.tasks = []
    const staleHome = mixed.secondmate_current.records[0]
    staleHome.freshness.status = "cached"
    const unknownHome = structuredClone(staleHome)
    unknownHome.id = "mate-unknown"
    unknownHome.home = "/srv/mate-unknown"
    unknownHome.host = "host-unknown"
    unknownHome.freshness.status = "unexpected"
    mixed.secondmate_current.records.push(unknownHome)
    mixed.secondmate_current.total_registered = 2
    mixed.secondmate_current.total = 2
    mixed.secondmate_current.shown = 2

    expect(normalizeFirstmate(mixed, "/tmp/fm-home", "/tmp/fm-root").freshness).toBe("stale")
  })

  test("rejects invalid envelopes, types, selected home, and roots", () => {
    expect(() => normalizeFirstmate(null, "/tmp/fm-home", "/tmp/fm-root")).toThrow()
    expect(() => normalizeFirstmate({ ...fixture, schema: "other" }, "/tmp/fm-home", "/tmp/fm-root")).toThrow()
    expect(() => normalizeFirstmate({ ...fixture, tasks: {} }, "/tmp/fm-home", "/tmp/fm-root")).toThrow()
    expect(() => normalizeFirstmate({ ...fixture, fm_home: "/tmp/other" }, "/tmp/fm-home", "/tmp/fm-root")).toThrow()
    expect(() => normalizeFirstmate({ ...fixture, roots: { ...fixture.roots, state: "/tmp/escape" } }, "/tmp/fm-home", "/tmp/fm-root")).toThrow()
    expect(() => normalizeFirstmate({ ...fixture, roots: { ...fixture.roots, state: "/tmp" } }, "/tmp/fm-home", "/tmp/fm-root")).toThrow()
  })
})
