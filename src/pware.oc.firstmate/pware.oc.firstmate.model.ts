export const FIRSTMATE_SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1" as const

export type FirstmateAvailability = "available" | "unavailable"
export type FirstmateCompleteness = "complete" | "partial" | "unknown"
export type FirstmateFreshness = "fresh" | "stale" | "unknown"

export type FirstmateWorkItem = {
  home: string
  host?: string | null
  remote?: boolean
  taskId: string
  taskKind?: string | null
  project: string | null
  title: string | null
  harness: string | null
  backend: string | null
  worktree: string | null
  durableState: string | null
  currentRole?: string | null
  currentState: string | null
  currentSource?: string | null
  currentDetail?: string | null
  currentReason?: string | null
  holdKind?: string | null
  holdBucket: string | null
  holdReason?: string | null
  blockedReason?: string | null
  holdUntil?: string | null
  holdAgeDays?: number | null
  captainActionable: boolean | null
  blockedByIds?: string[]
  unresolvedBlockerIds?: string[]
  /** Kept for the compact UI contract. Same values as unresolvedBlockerIds. */
  unresolvedBlockers: string[]
  provenance: string[]
  provenanceSelected?: string | null
  provenanceTrust?: string | null
  sourceFreshness?: string | null
  freshness: FirstmateFreshness
  observedAt: number | null
  ageSeconds?: number | null
  homeCounts?: Record<string, number> | null
  decisions?: FirstmateDecision[]
  warning?: string
}

export type FirstmateDecision = {
  key: string | null
  verb: string | null
  summary: string | null
  reason: string | null
  source: string | null
  holdUntil: string | null
  holdBucket: string | null
  holdAgeDays: number | null
  captainActionable: boolean
}

export type FirstmateHomeSummary = {
  id: string
  home: string | null
  host: string | null
  remote: boolean
  currentState: string | null
  currentReason: string | null
  provenanceSelected: string | null
  provenanceTrust: string | null
  summarySource: string | null
  sourceFreshness: string | null
  observedAt: number | null
  ageSeconds: number | null
  counts: Record<string, number> | null
  omitted: { surface: string | null; count: number | null }[]
}

export type FirstmateSnapshot = {
  availability: FirstmateAvailability
  completeness: FirstmateCompleteness
  freshness: FirstmateFreshness
  observedAt: number | null
  diagnostic: string[]
  home: string
  root: string
  workItems: FirstmateWorkItem[]
  /** Canonical registered-home summaries, including unavailable homes with no projected work. */
  homes?: FirstmateHomeSummary[]
}

export function unavailableFirstmate(home: string, root: string, diagnostic: string): FirstmateSnapshot {
  return {
    availability: "unavailable",
    completeness: "unknown",
    freshness: "unknown",
    observedAt: null,
    diagnostic: [diagnostic],
    home,
    root,
    workItems: [],
    homes: [],
  }
}
