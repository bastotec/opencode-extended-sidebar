/**
 * Compact, durable Firstmate inventory rows for the My work sidebar.
 * These rows deliberately describe only snapshot state: they never borrow
 * OpenCode's live pulse, spinner, flow, or age signals.
 */
import type { FirstmateSnapshot, FirstmateWorkItem } from "../pware.oc.firstmate/pware.oc.firstmate.model.js"
import type { GlyphSpec, ToneKey } from "./pware.oc.ui.glyphs.js"
import { clipWidth } from "../pware.oc.core/pware.oc.core.width.js"

export type FirstmateState = {
  label: string
  glyph: GlyphSpec
}

export type FirstmateRow = {
  name: string
  context: string | undefined
  suffix: string
  glyph: GlyphSpec
  bodyTone: ToneKey
}

export type FirstmateNotice = {
  label: string
  glyph: GlyphSpec
}

/** A compact plan for a Firstmate section under the sidebar's row budget. */
export type FirstmateSection = { show: boolean; showNotice: boolean; workRows: number; showList: boolean }

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/[ _]+/g, "-") ?? ""
}

function matches(value: string, ...names: string[]): boolean {
  return names.includes(value)
}

function customLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

/**
 * Resolve the one state a durable row can honestly show. Blockers win, then a
 * hold and queue, then the durable in-flight lane; only then can the most
 * recent observed state describe the work. Unknown custom values stay visible
 * without borrowing a lifecycle meaning from the UI.
 */
export function firstmateState(work: FirstmateWorkItem): FirstmateState {
  const durable = normalized(work.durableState)
  const current = normalized(work.currentState)
  const states = [durable, current]
  const blockers = work.unresolvedBlockerIds ?? []
  if (blockers.length > 0 || states.some((state) => matches(state, "blocked"))) {
    return { label: "Blocked", glyph: { char: "!", tone: "warning" } }
  }
  if (
    normalized(work.currentRole) === "held"
    || work.holdKind?.trim()
    || work.holdBucket?.trim()
    || work.holdReason?.trim()
    || work.holdUntil?.trim()
  ) {
    return { label: "Held", glyph: { char: "⊘", tone: "textMuted" } }
  }
  if (states.some((state) => matches(state, "queued", "queue"))) {
    return { label: "Queued", glyph: { char: "⧗", tone: "warning" } }
  }
  const observed = current || durable
  // A durable in-flight record is useful only until a canonical observation
  // says more. A custom observation remains visible, but neutral.
  if (matches(durable, "in-flight", "inflight", "active") && !current) {
    return { label: "In flight", glyph: { char: "▸", tone: "primary" } }
  }
  if (matches(observed, "working", "running")) {
    return { label: "Working", glyph: { char: "▸", tone: "success" } }
  }
  if (matches(observed, "paused", "parked")) {
    return { label: observed === "parked" ? "Parked" : "Paused", glyph: { char: "⊘", tone: "textMuted" } }
  }
  if (matches(observed, "failed", "error")) {
    return { label: "Failed", glyph: { char: "×", tone: "error" } }
  }
  const custom = work.currentState?.trim() || work.durableState?.trim()
  if (custom) return { label: customLabel(custom), glyph: { char: "•", tone: "textMuted" } }
  return { label: "Unknown", glyph: { char: "•", tone: "textMuted" } }
}

/** Project and harness are useful context; backend follows only when distinct. */
export function firstmateContext(work: FirstmateWorkItem): string | undefined {
  const context = [work.project?.trim(), work.harness?.trim()]
  const backend = work.backend?.trim()
  if (backend && !context.some((value) => value?.toLowerCase() === backend.toLowerCase())) context.push(backend)
  const values = context.filter((value): value is string => Boolean(value))
  return values.length > 0 ? values.join(" · ") : undefined
}

export function firstmateRow(work: FirstmateWorkItem): FirstmateRow {
  const state = firstmateState(work)
  const task = work.taskId.trim() || "task"
  const title = work.title?.trim()
  return {
    name: title && title !== task ? `${task} · ${title}` : task,
    context: firstmateContext(work),
    suffix: state.label,
    glyph: state.glyph,
    bodyTone: state.glyph.tone === "error" ? "error" : "text",
  }
}

/** At most one inventory health line; diagnostics themselves remain private. */
export function firstmateNotice(snapshot: FirstmateSnapshot | undefined): FirstmateNotice | null {
  if (!snapshot) return null
  const conditions = [
    snapshot.availability === "unavailable" ? "unavailable" : null,
    snapshot.completeness === "partial" ? "partial" : null,
    snapshot.freshness === "stale"
      ? "stale"
      : snapshot.freshness === "unknown"
        ? "freshness unknown"
        : null,
  ].filter((condition): condition is string => Boolean(condition))
  if (conditions.length > 0) return { label: `Inventory ${conditions.join(" · ")}`, glyph: { char: "•", tone: "textMuted" } }
  return null
}

/**
 * Allocate the health line and work rows as one section, never as overflow, and
 * keep durable work reachable when the vertical budget cannot show a work row.
 * The header uses `showList` for the same compact `view all` affordance as the
 * existing file sections; it never spends an extra sidebar row.
 */
export function firstmateSection(
  allocation: number,
  hasNotice: boolean,
  workCount: number,
): FirstmateSection {
  const rows = Math.max(0, Math.round(allocation))
  const workRows = rows === 0 ? 0 : Math.max(0, rows - (hasNotice ? 1 : 0))
  return {
    show: rows > 0,
    showNotice: rows > 0 && hasNotice,
    workRows,
    showList: Math.max(0, Math.round(workCount)) > 0 && workRows === 0,
  }
}

function bounded(value: string, max = 96): string {
  return clipWidth(value.replace(/\s+/g, " ").trim(), max)
}

function add(lines: string[], label: string, value: string | number | null | undefined): void {
  const text = typeof value === "number" ? String(value) : value?.trim()
  if (text) lines.push(`${label}: ${bounded(text)}`)
}

function list(value: readonly string[] | null | undefined): string | null {
  const values = (value ?? []).map((item) => item.trim()).filter(Boolean)
  if (values.length === 0) return null
  const shown = values.slice(0, 5)
  return `${shown.join(", ")}${values.length > shown.length ? ` · +${values.length - shown.length}` : ""}`
}

function observationAge(work: FirstmateWorkItem, now: number): string | null {
  // `observedAt` is the event's own clock and remains meaningful while a
  // snapshot is retained as stale. Producer age is only a fallback because
  // this DTO carries no separate age-sample timestamp to advance from.
  const seconds = work.observedAt == null
    ? work.ageSeconds ?? null
    : Math.max(0, Math.floor((now - work.observedAt) / 1_000))
  if (seconds == null || !Number.isFinite(seconds)) return null
  if (seconds < 60) return `${Math.floor(seconds)}s old`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m old`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h old`
  return `${Math.floor(seconds / 86_400)}d old`
}

function decisionLine(decision: NonNullable<FirstmateWorkItem["decisions"]>[number]): string {
  const facts = [
    decision.verb,
    decision.summary,
    decision.reason,
    decision.source,
    decision.holdBucket ? `bucket ${decision.holdBucket}` : null,
    decision.holdUntil ? `until ${decision.holdUntil}` : null,
    decision.holdAgeDays == null ? null : `${decision.holdAgeDays}d`,
    decision.captainActionable ? "actionable" : "not actionable",
  ].filter((fact): fact is string => Boolean(fact))
  return bounded(facts.join(" · "))
}

/** Read-only facts for the existing terminal detail dialog. Absent fields stay absent. */
export function firstmateDetailLines(work: FirstmateWorkItem, now = Date.now()): string[] {
  const lines: string[] = []
  add(lines, "Task", work.taskId)
  add(lines, "Title", work.title)
  add(lines, "Kind", work.taskKind)
  add(lines, "Project", work.project)
  add(lines, "Durable state", work.durableState)
  add(lines, "Current role", work.currentRole)
  add(lines, "Observed state", work.currentState)
  add(lines, "Observed source", work.currentSource)
  add(lines, "Observed detail", work.currentDetail)
  add(lines, "Observed reason", work.currentReason)
  if (work.observedAt != null && Number.isFinite(work.observedAt)) add(lines, "Observed at", new Date(work.observedAt).toISOString())
  add(lines, "Observation age", observationAge(work, now))
  add(lines, "Harness", work.harness)
  add(lines, "Backend", work.backend)
  if (work.remote) add(lines, "Route", "remote")
  add(lines, "Host", work.host)
  add(lines, "Home", work.home)
  add(lines, "Worktree", work.worktree)
  add(lines, "Hold kind", work.holdKind)
  add(lines, "Hold bucket", work.holdBucket)
  add(lines, "Hold reason", work.holdReason)
  add(lines, "Hold until", work.holdUntil)
  if (work.captainActionable != null) add(lines, "Captain actionable", work.captainActionable ? "yes" : "no")
  add(lines, "Dependencies", list(work.blockedByIds))
  add(lines, "Unresolved blockers", list(work.unresolvedBlockerIds))
  add(lines, "Blocked reason", work.blockedReason)
  const decisions = work.decisions ?? []
  for (const decision of decisions.slice(0, 5)) {
    const label = decision.key?.trim() ? `Decision ${decision.key.trim()}` : "Decision"
    add(lines, label, decisionLine(decision))
  }
  if (decisions.length > 5) add(lines, "Decisions", `+${decisions.length - 5} more`)
  add(lines, "Provenance", list(work.provenance))
  add(lines, "Selected provenance", work.provenanceSelected)
  add(lines, "Provenance trust", work.provenanceTrust)
  add(lines, "Source freshness", work.sourceFreshness)
  add(lines, "Freshness", work.freshness)
  add(lines, "Warning", work.warning)
  return lines
}
