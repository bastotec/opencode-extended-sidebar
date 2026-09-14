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
  provenance: string[]
  provenanceSelected?: string | null
  provenanceTrust?: string | null
  sourceFreshness?: string | null
  freshness: FirstmateFreshness
  observedAt: number | null
  ageSeconds?: number | null
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

export type FirstmateSnapshot = {
  availability: FirstmateAvailability
  completeness: FirstmateCompleteness
  freshness: FirstmateFreshness
  observedAt: number | null
  diagnostic: string[]
  home: string
  root: string
  workItems: FirstmateWorkItem[]
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
  }
}
