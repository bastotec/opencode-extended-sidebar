import { describe, expect, test } from "bun:test"
import type { FirstmateSnapshot, FirstmateWorkItem } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.model.js"
import { composeRow } from "../../../src/pware.oc.ui/pware.oc.ui.sections.js"
import { firstmateBudget, firstmateContext, firstmateDetailLines, firstmateNotice, firstmateRow, firstmateSection, firstmateState } from "../../../src/pware.oc.ui/pware.oc.ui.firstmate.js"

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

const work = (patch: Partial<FirstmateWorkItem> = {}): FirstmateWorkItem => ({
  home: "/fleet",
  taskId: "task-42",
  taskKind: "delivery",
  project: "sidebar",
  title: "Wire durable inventory",
  harness: "opencode",
  backend: "local",
  worktree: "/fleet/sidebar",
  durableState: null,
  currentRole: null,
  currentState: null,
  currentSource: null,
  currentDetail: null,
  currentReason: null,
  holdKind: null,
  holdBucket: null,
  holdReason: null,
  holdUntil: null,
  captainActionable: null,
  blockedByIds: [],
  unresolvedBlockerIds: [],
  unresolvedBlockers: [],
  provenance: [],
  provenanceSelected: null,
  provenanceTrust: null,
  sourceFreshness: null,
  freshness: "fresh",
  observedAt: NOW - 90_000,
  ageSeconds: 90,
  ...patch,
})

const snapshot = (patch: Partial<FirstmateSnapshot> = {}): FirstmateSnapshot => ({
  availability: "available",
  completeness: "complete",
  freshness: "fresh",
  observedAt: NOW,
  diagnostic: [],
  home: "/fleet",
  root: "/fleet",
  workItems: [],
  ...patch,
})

describe("Firstmate sidebar rows", () => {
  test("keeps durable work visible without a live OpenCode session", () => {
    const row = firstmateRow(work())
    expect(row.name).toBe("task-42 · Wire durable inventory")
    expect(row.context).toBe("sidebar · opencode · local")
    expect(row).not.toHaveProperty("selectable")
    expect(row).not.toHaveProperty("sessionId")
  })

  test("keeps opencode, codex, and custom harness labels neutral", () => {
    expect(firstmateContext(work({ harness: "opencode", backend: "opencode" }))).toBe("sidebar · opencode")
    expect(firstmateContext(work({ harness: "codex", backend: "remote" }))).toBe("sidebar · codex · remote")
    expect(firstmateContext(work({ harness: "my-runner", backend: null }))).toBe("sidebar · my-runner")
  })

  test("uses canonical blockers, held metadata, and observed state precedence", () => {
    expect(firstmateState(work({ durableState: "queued", blockedByIds: ["review-1"] })).label).toBe("Queued")
    expect(firstmateState(work({ durableState: "queued", unresolvedBlockerIds: ["review-1"] })).label).toBe("Blocked")
    expect(firstmateState(work({ durableState: "blocked" })).label).toBe("Blocked")
    expect(firstmateState(work({ currentState: "blocked" })).label).toBe("Blocked")
    expect(firstmateState(work({ durableState: "queued", currentRole: "held" })).label).toBe("Held")
    expect(firstmateState(work({ durableState: "queued", holdReason: "waiting for owner" })).label).toBe("Held")
    expect(firstmateState(work({ durableState: "queued", blockedReason: "resolved last week" })).label).toBe("Queued")
    expect(firstmateState(work({ durableState: "queued" })).label).toBe("Queued")
    expect(firstmateState(work({ durableState: "in_flight", currentState: "working" })).label).toBe("Working")
    expect(firstmateState(work({ durableState: "in_flight", currentState: "parked" })).label).toBe("Parked")
    expect(firstmateState(work({ durableState: "in_flight", currentState: "failed" })).label).toBe("Failed")
    expect(firstmateState(work({ durableState: "in_flight" })).label).toBe("In flight")
    expect(firstmateState(work({ durableState: "in_flight", currentState: "custom-state" })).label).toBe("Custom State")
    expect(firstmateState(work({ currentState: "custom-state" })).label).toBe("Custom State")
    expect(firstmateState(work()).label).toBe("Unknown")
  })

  test("keeps details read-only, complete where present, and omits absent facts", () => {
    const lines = firstmateDetailLines(work({
      durableState: "in_flight",
      currentRole: "worker",
      currentState: "parked",
      currentSource: "secondmate",
      currentDetail: "awaiting review",
      currentReason: "review queue",
      holdKind: "review",
      holdBucket: "captain",
      holdReason: "owner decision",
      holdUntil: "2026-09-15",
      captainActionable: true,
      remote: true,
      host: "fleet.example.test",
      blockedByIds: ["dep-1"],
      unresolvedBlockerIds: ["dep-2"],
      blockedReason: "release gate",
      decisions: [
        { key: "review", verb: "hold", summary: "Await review", reason: "release gate", source: "captain", holdUntil: null, holdBucket: "captain", holdAgeDays: 1, captainActionable: true },
        { key: "retry", verb: "retry", summary: "Retry after merge", reason: null, source: "planner", holdUntil: "2026-09-15", holdBucket: null, holdAgeDays: null, captainActionable: false },
      ],
      provenance: ["backlog", "secondmate"],
      provenanceSelected: "secondmate",
      provenanceTrust: "verified",
      sourceFreshness: "fresh",
      warning: "inventory may be incomplete",
    }), NOW)
    expect(lines).toEqual(expect.arrayContaining([
      "Task: task-42",
      "Durable state: in_flight",
      "Observed state: parked",
      "Observed source: secondmate",
      "Observed detail: awaiting review",
      "Observed reason: review queue",
      "Observed at: 2026-09-14T11:58:30.000Z",
      "Observation age: 1m old",
      "Hold kind: review",
      "Hold bucket: captain",
      "Hold reason: owner decision",
      "Hold until: 2026-09-15",
      "Captain actionable: yes",
      "Route: remote",
      "Host: fleet.example.test",
      "Dependencies: dep-1",
      "Unresolved blockers: dep-2",
      "Blocked reason: release gate",
      "Decision review: hold · Await review · release gate · captain · bucket captain · 1d · actionable",
      "Decision retry: retry · Retry after merge · planner · until 2026-09-15 · not actionable",
      "Provenance trust: verified",
      "Warning: inventory may be incomplete",
    ]))
    expect(firstmateDetailLines(work({ title: null, currentDetail: null, warning: undefined }), NOW)).not.toContain("Title: Wire durable inventory")
  })

  test("advances a retained observation age from observedAt, not a frozen producer age", () => {
    const stale = work({ freshness: "stale", observedAt: NOW - 90_000, ageSeconds: 1 })
    expect(firstmateDetailLines(stale, NOW)).toContain("Observation age: 1m old")
    expect(firstmateDetailLines(stale, NOW + 120_000)).toContain("Observation age: 3m old")
    expect(firstmateDetailLines(work({ observedAt: null, ageSeconds: 90 }), NOW)).toContain("Observation age: 1m old")
  })

  test("keeps OpenCode, Codex, and custom workers detail-only", () => {
    for (const row of [
      firstmateRow(work({ harness: "opencode" })),
      firstmateRow(work({ harness: "codex" })),
      firstmateRow(work({ harness: "my-runner" })),
    ]) {
      expect(row).not.toHaveProperty("selectable")
      expect(row).not.toHaveProperty("sessionId")
    }
  })

  test("clips identity and context through the existing narrow row budget", () => {
    const row = firstmateRow(work({ title: "A deliberately long durable task title", project: "very-long-project-name" }))
    const composed = composeRow({ kind: "agent", name: row.name, title: row.context, suffix: row.suffix }, 22)
    expect(composed.body.length).toBeLessThanOrEqual(22 - composed.suffix.length - 1)
    expect(composed.truncated).toBe(true)
  })

  test("surfaces unavailable, partial, stale, and unknown inventory honestly", () => {
    expect(firstmateNotice(undefined)).toBeNull()
    expect(firstmateNotice(snapshot({ availability: "unavailable", completeness: "partial", freshness: "stale" }))?.label).toBe("Inventory unavailable · partial · stale")
    expect(firstmateNotice(snapshot({ completeness: "partial", freshness: "stale" }))?.label).toBe("Inventory partial · stale")
    expect(firstmateNotice(snapshot({ freshness: "unknown" }))?.label).toBe("Inventory freshness unknown")
    // The corrected normalizer keeps a stale source visible even when another
    // source is unknown, so the aggregate snapshot reaches the UI as stale.
    expect(firstmateNotice(snapshot({ completeness: "unknown", freshness: "stale" }))?.label).toBe("Inventory stale")
  })

  test("keeps durable work reachable through the header when no work row fits", () => {
    expect(firstmateBudget(0, true)).toEqual({ show: false, showNotice: false, workRows: 0 })
    expect(firstmateBudget(1, true)).toEqual({ show: true, showNotice: true, workRows: 0 })
    expect(firstmateBudget(2, true)).toEqual({ show: true, showNotice: true, workRows: 1 })
    expect(firstmateBudget(1, false)).toEqual({ show: true, showNotice: false, workRows: 1 })
    // This is the sidebar's real access decision: the `view all` header action
    // appears when rows cannot render work, not merely when allocation is zero.
    expect(firstmateSection(0, false, 1)).toMatchObject({ show: false, workRows: 0, showList: true })
    expect(firstmateSection(1, true, 1)).toMatchObject({ show: true, showNotice: true, workRows: 0, showList: true })
    expect(firstmateSection(2, true, 1)).toMatchObject({ workRows: 1, showList: false })
    expect(firstmateSection(0, false, 0)).toMatchObject({ showList: false })
  })
})
