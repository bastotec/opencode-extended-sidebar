import path from "node:path"
import {
  FIRSTMATE_SNAPSHOT_SCHEMA,
  type FirstmateFreshness,
  type FirstmateHomeSummary,
  type FirstmateSnapshot,
  type FirstmateWorkItem,
} from "./pware.oc.firstmate.model.js"

type JsonObject = Record<string, unknown>
const DISPLAY_MAX = 1_024
const SECONDMATE_SURFACES = ["active_children", "decisions_open", "holds", "queued", "landed", "endpoints"] as const
const SECONDMATE_ROW_STRING_FIELDS = [
  "kind", "state", "repo", "name", "source", "doing", "title", "blocked_reason", "hold_reason", "hold_kind",
  "hold_until", "hold_bucket", "reason", "key", "verb", "summary",
] as const

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null
}

function requiredObject(row: JsonObject, key: string): JsonObject {
  const value = object(row[key])
  if (!value) throw new Error(`Firstmate snapshot ${key} must be an object`)
  return value
}

function requiredArray(row: JsonObject, key: string): unknown[] {
  const value = row[key]
  if (!Array.isArray(value)) throw new Error(`Firstmate snapshot ${key} must be an array`)
  return value
}

function requiredString(row: JsonObject, key: string): string {
  const value = text(row[key])
  if (!value) throw new Error(`Firstmate snapshot ${key} must be a string`)
  return value
}

function requiredBoolean(row: JsonObject, key: string): boolean {
  if (typeof row[key] !== "boolean") throw new Error(`Firstmate snapshot ${key} must be a boolean`)
  return row[key]
}

function requiredNumber(row: JsonObject, key: string): number {
  const value = row[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Firstmate snapshot ${key} must be a non-negative number`)
  }
  return value
}

function requireStringType(row: JsonObject, key: string, nullable = false): void {
  const value = row[key]
  if (typeof value !== "string" && !(nullable && value === null)) {
    throw new Error(`Firstmate snapshot ${key} must be ${nullable ? "a string or null" : "a string"}`)
  }
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
  return clean ? clean.slice(0, DISPLAY_MAX) : null
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function time(value: unknown): number | null {
  const valueText = text(value)
  if (!valueText) return null
  const parsed = Date.parse(valueText)
  return Number.isFinite(parsed) ? parsed : null
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(text).filter((entry): entry is string => entry !== null).slice(0, 256)
}

function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return []
  return value.map(object).filter((entry): entry is JsonObject => entry !== null)
}

function fresh(value: unknown): FirstmateFreshness {
  const status = text(value)?.toLowerCase()
  if (status === "fresh") return "fresh"
  if (status === "cached" || status === "stale") return "stale"
  return "unknown"
}

function aggregateFreshness(current: FirstmateFreshness, observed: FirstmateFreshness): FirstmateFreshness {
  if (current === "stale" || observed === "stale") return "stale"
  if (current === "unknown" || observed === "unknown") return "unknown"
  return "fresh"
}

function within(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function validateEnvelope(value: unknown, configuredHome: string, configuredRoot: string): {
  backlog: JsonObject
  tasks: JsonObject[]
  main: JsonObject
  current: JsonObject
  landed: JsonObject
  generatedAt: number
} {
  const payload = object(value)
  if (!payload) throw new Error("Firstmate snapshot is not an object")
  if (payload.schema !== FIRSTMATE_SNAPSHOT_SCHEMA) throw new Error("Unsupported Firstmate snapshot schema")
  const generated = requiredString(payload, "generated")
  const generatedAt = time(generated)
  if (generatedAt === null) throw new Error("Firstmate snapshot generated is not a timestamp")
  if (requiredString(payload, "fm_home") !== configuredHome) throw new Error("Firstmate snapshot home does not match the selected home")

  const roots = requiredObject(payload, "roots")
  if (requiredString(roots, "fm_root") !== configuredRoot) throw new Error("Firstmate snapshot root does not match the selected root")
  for (const key of ["state", "data", "config", "projects"]) {
    const value = path.resolve(requiredString(roots, key))
    if (!within(configuredHome, value)) throw new Error(`Firstmate snapshot ${key} root escapes the selected home`)
  }

  const backlog = requiredObject(payload, "backlog")
  requiredBoolean(backlog, "present")
  requiredString(backlog, "path")
  for (const entry of requiredArray(backlog, "records")) {
    const row = object(entry)
    if (!row) throw new Error("Firstmate snapshot backlog record must be an object")
    if (row.structured === true) {
      requiredString(row, "id")
      requiredString(row, "state")
      requiredArray(row, "blocked_by_ids")
      requiredArray(row, "unresolved_blocker_ids")
    }
  }
  const tasks = requiredArray(payload, "tasks").map((entry) => {
    const row = object(entry)
    if (!row) throw new Error("Firstmate snapshot task must be an object")
    requiredString(row, "id")
    for (const key of ["kind", "harness", "project", "backend"]) requireStringType(row, key)
    const state = requiredObject(row, "current_state")
    for (const key of ["state", "source", "detail", "observed_at", "freshness"]) requireStringType(state, key)
    const paths = requiredObject(row, "paths")
    const worktree = requiredObject(paths, "worktree")
    requireStringType(worktree, "path", true)
    return row
  })
  const main = requiredObject(payload, "main_inventory")
  requiredBoolean(main, "valid")
  if (main.reason !== null && main.reason !== undefined && typeof main.reason !== "string") {
    throw new Error("Firstmate snapshot main_inventory.reason must be a string or null")
  }
  requiredArray(main, "orphan_in_flight")
  requiredNumber(main, "unstructured_current_count")

  const current = requiredObject(payload, "secondmate_current")
  const registry = requiredObject(current, "registry")
  for (const key of ["present", "available", "complete", "input_truncated", "records_truncated"]) requiredBoolean(registry, key)
  requiredArray(registry, "records")
  requiredArray(registry, "reasons")
  requiredArray(current, "records")
  for (const key of ["total_registered", "total", "shown", "truncated"]) requiredNumber(current, key)
  const landed = requiredObject(payload, "secondmate_landed")
  for (const key of ["records", "truncated", "unreadable", "partial"]) requiredArray(landed, key)
  return { backlog, tasks, main, current, landed, generatedAt }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function validOptionalString(row: JsonObject, key: string): boolean {
  return row[key] === undefined || row[key] === null || typeof row[key] === "string"
}

function sanitizeSecondmateRecords(value: unknown, diagnostic: string[]): { records: JsonObject[]; partial: boolean } {
  const raw = Array.isArray(value) ? value : []
  const records: JsonObject[] = []
  let partial = false
  const mark = (id: string, detail: string): void => {
    partial = true
    diagnostic.push(`secondmate ${id}: ${detail}`)
  }
  for (let index = 0; index < raw.length; index++) {
    const summary = object(raw[index])
    const id = text(summary?.id) ?? `record ${index + 1}`
    if (!summary || !text(summary.id) || typeof summary.remote !== "boolean" || typeof summary.registered !== "boolean"
      || !validOptionalString(summary, "host") || !validOptionalString(summary, "home")
      || !object(summary.current) || !object(summary.provenance) || !object(summary.freshness) || !object(summary.counts)) {
      mark(id, "malformed current home summary")
      continue
    }

    const copy: JsonObject = { ...summary }
    let summaryValid = true
    const current = object(summary.current)!
    const provenance = object(summary.provenance)!
    const freshness = object(summary.freshness)!
    if (!text(current.state) || !validOptionalString(current, "reason")
      || !text(provenance.selected) || !validOptionalString(provenance, "trust")
      || !["structured_home", "summary_source", "parent_event_role"].every((key) => validOptionalString(provenance, key))
      || (provenance.summary_valid !== undefined && typeof provenance.summary_valid !== "boolean")
      || !text(freshness.status) || (freshness.observed_at !== null && freshness.observed_at !== undefined && time(freshness.observed_at) === null)
      || (freshness.age_seconds !== null && freshness.age_seconds !== undefined
        && (typeof freshness.age_seconds !== "number" || !Number.isFinite(freshness.age_seconds) || freshness.age_seconds < 0))) {
      mark(id, "malformed current, provenance, or freshness fields")
      summaryValid = false
    }
    if (text(provenance.selected) === "structured-home" && !text(summary.home)) {
      mark(id, "structured home has no home path")
      summaryValid = false
    }
    for (const surface of SECONDMATE_SURFACES) {
      const rows = summary[surface]
      if (!Array.isArray(rows)) {
        mark(id, `${surface} must be an array`)
        copy[surface] = []
        summaryValid = false
        continue
      }
      const clean: JsonObject[] = []
      for (const entry of rows) {
        const row = object(entry)
        if (!row || !text(row.id)) {
          mark(id, `malformed ${surface} row`)
          summaryValid = false
          continue
        }
        const blockerFieldsValid = ["blocked_by_ids", "unresolved_blocker_ids"].every((key) =>
          row[key] === undefined || (Array.isArray(row[key]) && (row[key] as unknown[]).every((item) => typeof item === "string")),
        )
        const stringsValid = SECONDMATE_ROW_STRING_FIELDS.every((key) => validOptionalString(row, key))
        const holdAgeValid = row.hold_age_days === undefined || row.hold_age_days === null
          || (typeof row.hold_age_days === "number" && Number.isFinite(row.hold_age_days) && row.hold_age_days >= 0)
        const actionableValid = row.captain_actionable === undefined || row.captain_actionable === null || typeof row.captain_actionable === "boolean"
        if (!blockerFieldsValid || !stringsValid || !holdAgeValid || !actionableValid) {
          mark(id, `malformed ${surface} fields for ${text(row.id)}`)
          summaryValid = false
          continue
        }
        clean.push(row)
      }
      copy[surface] = clean
    }

    const omitted = summary.omitted
    const omittedCounts = new Map<string, number>()
    if (!Array.isArray(omitted)) {
      mark(id, "omitted must be an array")
      copy.omitted = []
      summaryValid = false
    } else {
      const clean: JsonObject[] = []
      for (const entry of omitted) {
        const row = object(entry)
        const surface = text(row?.surface)
        const count = row?.count
        if (!row || !surface || !SECONDMATE_SURFACES.includes(surface as typeof SECONDMATE_SURFACES[number]) || !nonNegativeInteger(count)) {
          mark(id, "malformed omitted surface")
          summaryValid = false
          continue
        }
        omittedCounts.set(surface, (omittedCounts.get(surface) ?? 0) + count)
        clean.push(row)
      }
      copy.omitted = clean
    }

    const countRow = object(summary.counts)!
    for (const surface of SECONDMATE_SURFACES) {
      const count = countRow[surface]
      const shown = (copy[surface] as JsonObject[]).length
      const expected = shown + (omittedCounts.get(surface) ?? 0)
      if (!nonNegativeInteger(count) || count !== expected) {
        mark(id, `${surface} count ${String(count)} does not match ${expected} shown or omitted`)
        summaryValid = false
      }
    }
    if (!summaryValid) {
      copy.provenance = { ...provenance, trust: provenance.trust === "complete" ? "partial-structured" : provenance.trust }
    }
    records.push(copy)
  }
  return { records, partial }
}

function emptyItem(home: string, taskId: string): FirstmateWorkItem {
  return {
    home,
    host: null,
    remote: false,
    taskId,
    taskKind: null,
    project: null,
    title: null,
    harness: null,
    backend: null,
    worktree: null,
    durableState: null,
    currentRole: null,
    currentState: null,
    currentSource: null,
    currentDetail: null,
    currentReason: null,
    holdKind: null,
    holdBucket: null,
    holdReason: null,
    blockedReason: null,
    holdUntil: null,
    holdAgeDays: null,
    captainActionable: null,
    blockedByIds: [],
    unresolvedBlockerIds: [],
    unresolvedBlockers: [],
    provenance: [],
    provenanceSelected: null,
    provenanceTrust: null,
    sourceFreshness: null,
    freshness: "unknown",
    observedAt: null,
    ageSeconds: null,
    homeCounts: null,
    decisions: [],
  }
}

function counts(value: unknown): Record<string, number> | null {
  const row = object(value)
  if (!row) return null
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(row)) if (typeof count === "number" && Number.isFinite(count)) out[key] = count
  return out
}

function mainItems(home: string, generatedAt: number, backlog: JsonObject, tasks: JsonObject[]): FirstmateWorkItem[] {
  const backlogRows = objects(backlog.records)
  const structured = backlogRows.filter((row) => row.structured === true && text(row.id))
  const backlogById = new Map(structured.map((row) => [text(row.id)!, row]))
  const taskById = new Map(tasks.map((row) => [text(row.id)!, row]))
  const ids = [...backlogById.keys(), ...[...taskById.keys()].filter((id) => !backlogById.has(id))]
  const out: FirstmateWorkItem[] = []
  for (const id of ids) {
    const durable = backlogById.get(id)
    const task = taskById.get(id)
    const durableState = text(durable?.state)?.toLowerCase() ?? null
    if (durableState === "done") continue
    const current = object(task?.current_state)
    const paths = object(task?.paths)
    const worktree = object(paths?.worktree)
    const observedAt = time(current?.observed_at) ?? generatedAt
    const sourceFreshness = text(current?.freshness)
    const blockedByIds = strings(durable?.blocked_by_ids)
    const unresolvedBlockerIds = strings(durable?.unresolved_blocker_ids)
    const item = emptyItem(home, id)
    Object.assign(item, {
      taskKind: text(task?.kind) ?? text(durable?.kind),
      project: text(task?.project) ?? text(durable?.repo),
      title: text(durable?.title),
      harness: text(task?.harness),
      backend: text(task?.backend),
      worktree: text(worktree?.path),
      durableState,
      currentRole: text(durable?.current_role),
      currentState: text(current?.state),
      currentSource: text(current?.source),
      currentDetail: text(current?.detail),
      holdKind: text(durable?.hold_kind),
      holdBucket: text(durable?.hold_bucket),
      holdReason: text(durable?.hold_reason),
      blockedReason: text(durable?.blocked_reason),
      holdUntil: text(durable?.hold_until),
      holdAgeDays: finite(durable?.hold_age_days),
      captainActionable: bool(durable?.captain_actionable),
      blockedByIds,
      unresolvedBlockerIds,
      unresolvedBlockers: unresolvedBlockerIds,
      provenance: [...new Set([...(durable ? ["main-backlog"] : []), ...(task ? ["main-task-metadata"] : [])])],
      sourceFreshness: sourceFreshness ?? "fresh",
      freshness: sourceFreshness ? fresh(sourceFreshness) : "fresh",
      observedAt,
    })
    if (!durable && task) item.warning = "Task metadata has no canonical backlog record"
    out.push(item)
  }
  return out
}

function secondmateItems(records: JsonObject[], diagnostic: string[]): {
  items: FirstmateWorkItem[]
  homes: FirstmateHomeSummary[]
} {
  const byKey = new Map<string, FirstmateWorkItem>()
  const homes: FirstmateHomeSummary[] = []
  const get = (home: string, host: string | null, remote: boolean, id: string): FirstmateWorkItem => {
    const key = `${remote ? `remote:${host ?? "unknown"}` : "local"}\0${home}\0${id}`
    let item = byKey.get(key)
    if (!item) {
      item = emptyItem(home, id)
      item.host = host
      item.remote = remote
      byKey.set(key, item)
    }
    return item
  }

  for (const summary of records) {
    const home = text(summary.home)
    const host = text(summary.host)
    const remote = summary.remote === true
    const homeId = text(summary.id) ?? "unknown"
    const provenance = object(summary.provenance)
    const selected = text(provenance?.selected)
    const trust = text(provenance?.trust)
    const current = object(summary.current)
    const freshness = object(summary.freshness)
    const sourceFreshness = text(freshness?.status)
    const observedAt = time(freshness?.observed_at)
    const ageSeconds = finite(freshness?.age_seconds)
    const homeCounts = counts(summary.counts)
    const reason = text(current?.reason)
    homes.push({
      id: homeId,
      home,
      host,
      remote,
      currentState: text(current?.state),
      currentReason: reason,
      provenanceSelected: selected,
      provenanceTrust: trust,
      summarySource: text(provenance?.summary_source),
      sourceFreshness,
      observedAt,
      ageSeconds,
      counts: homeCounts,
      omitted: objects(summary.omitted).map((entry) => ({ surface: text(entry.surface), count: finite(entry.count) })),
    })
    if (!home || selected !== "structured-home") {
      diagnostic.push(`secondmate ${homeId}: ${reason ?? "structured home unavailable"}`)
      continue
    }
    if (trust !== "complete") diagnostic.push(`secondmate ${homeId}: ${reason ?? "partial structured home"}`)
    for (const omitted of objects(summary.omitted)) {
      diagnostic.push(`secondmate ${homeId}: ${text(omitted.surface) ?? "inventory"} omitted ${finite(omitted.count) ?? 0}`)
    }
    const applyCommon = (item: FirstmateWorkItem, surface: string): void => {
      item.provenance = [...new Set([...item.provenance, `secondmate-${surface}`])]
      item.provenanceSelected = selected
      item.provenanceTrust = trust
      item.sourceFreshness = sourceFreshness
      item.freshness = fresh(sourceFreshness)
      item.observedAt = observedAt
      item.ageSeconds = ageSeconds
      item.homeCounts = homeCounts
      item.currentReason = reason
    }
    for (const row of objects(summary.active_children)) {
      const id = text(row.id)
      if (!id) continue
      const item = get(home, host, remote, id)
      applyCommon(item, "active-children")
      item.taskKind = text(row.kind)
      item.project = text(row.repo)
      item.title = text(row.name)
      item.durableState = "in_flight"
      item.currentState = text(row.state)
      item.currentSource = text(row.source)
      item.currentDetail = text(row.doing)
      item.currentRole = "worker"
    }
    for (const row of objects(summary.queued)) {
      const id = text(row.id)
      if (!id) continue
      const item = get(home, host, remote, id)
      applyCommon(item, "queued")
      item.taskKind = item.taskKind ?? text(row.kind)
      item.project = item.project ?? text(row.repo)
      item.title = item.title ?? text(row.title)
      item.durableState = item.durableState ?? "queued"
      item.holdKind = text(row.hold_kind)
      item.holdBucket = text(row.hold_bucket)
      item.holdReason = text(row.hold_reason)
      item.blockedReason = text(row.blocked_reason)
      item.holdUntil = text(row.hold_until)
      item.holdAgeDays = finite(row.hold_age_days)
      item.captainActionable = bool(row.captain_actionable)
      item.blockedByIds = strings(row.blocked_by_ids)
      item.unresolvedBlockerIds = strings(row.unresolved_blocker_ids)
      item.unresolvedBlockers = item.unresolvedBlockerIds
      if (item.holdKind) item.currentRole = "held"
    }
    for (const row of objects(summary.holds)) {
      const id = text(row.id)
      if (!id) continue
      const item = get(home, host, remote, id)
      applyCommon(item, "holds")
      item.title = item.title ?? text(row.title)
      item.currentRole = "held"
      item.currentDetail = item.currentDetail ?? text(row.reason)
      item.blockedByIds = item.blockedByIds?.length ? item.blockedByIds : strings(row.blocked_by_ids)
      item.unresolvedBlockerIds = item.unresolvedBlockerIds?.length ? item.unresolvedBlockerIds : strings(row.unresolved_blocker_ids)
      item.unresolvedBlockers = item.unresolvedBlockerIds ?? []
    }
    for (const row of objects(summary.decisions_open)) {
      const id = text(row.id)
      if (!id) continue
      const item = get(home, host, remote, id)
      applyCommon(item, "decisions-open")
      const verb = text(row.verb)
      const decisionHoldBucket = text(row.hold_bucket)
      const captainHold = verb === "captain-hold"
      const decision = {
        key: text(row.key),
        verb,
        summary: text(row.summary),
        reason: text(row.reason),
        source: text(row.source),
        holdUntil: text(row.hold_until),
        holdBucket: decisionHoldBucket,
        holdAgeDays: finite(row.hold_age_days),
        captainActionable: captainHold && decisionHoldBucket === "live",
      }
      item.decisions = [...(item.decisions ?? []), decision]
      item.title = item.title ?? decision.summary
      item.currentDetail = item.currentDetail ?? decision.reason ?? decision.summary
      if (captainHold) {
        item.currentRole = "held"
        item.holdKind = "captain"
        item.holdReason = decision.reason
        item.holdUntil = decision.holdUntil
        item.holdBucket = decision.holdBucket
        item.holdAgeDays = decision.holdAgeDays
        item.captainActionable = decision.captainActionable
      } else item.currentRole = item.currentRole ?? "decision"
    }
  }
  return { items: [...byKey.values()], homes }
}

export function normalizeFirstmate(value: unknown, configuredHome: string, configuredRoot: string): FirstmateSnapshot {
  const { backlog, tasks, main, current, landed, generatedAt } = validateEnvelope(value, configuredHome, configuredRoot)
  const diagnostic: string[] = []
  let partial = false
  let overallFreshness: FirstmateFreshness = "fresh"

  if (backlog.present !== true) {
    partial = true
    diagnostic.push("main backlog is absent")
  }
  if (main.valid !== true) {
    partial = true
    diagnostic.push(`main inventory: ${text(main.reason) ?? "invalid"}`)
  }
  const unstructuredCount = requiredNumber(main, "unstructured_current_count")
  if (unstructuredCount > 0) {
    partial = true
    diagnostic.push(`main inventory has ${unstructuredCount} unstructured current row${unstructuredCount === 1 ? "" : "s"}`)
  }
  const orphanRows = requiredArray(main, "orphan_in_flight")
  if (orphanRows.length > 0) {
    partial = true
    const orphanIds = orphanRows.map((entry) => text(object(entry)?.id) ?? text(entry)).filter((entry): entry is string => entry !== null)
    diagnostic.push(`main inventory has ${orphanRows.length} orphan in-flight item${orphanRows.length === 1 ? "" : "s"}${orphanIds.length ? `: ${orphanIds.join(", ")}` : ""}`)
  }

  for (const task of tasks) {
    const taskId = text(task.id) ?? "unknown"
    const status = fresh(text(object(task.current_state)?.freshness))
    if (status === "unknown") {
      diagnostic.push(`main task ${taskId} freshness is unknown`)
    } else if (status === "stale") {
      diagnostic.push(`main task ${taskId} is stale`)
    }
    overallFreshness = aggregateFreshness(overallFreshness, status)
  }

  const registry = requiredObject(current, "registry")
  const registryReasons = strings(registry.reasons)
  const registryFreshness = object(registry.freshness)
  if ((registry.reason !== null && registry.reason !== undefined && typeof registry.reason !== "string")
    || registryReasons.length !== requiredArray(registry, "reasons").length
    || !registryFreshness || !text(registryFreshness.status)
    || (registryFreshness.observed_at !== null && registryFreshness.observed_at !== undefined && time(registryFreshness.observed_at) === null)) {
    partial = true
    diagnostic.push("secondmate registry contains malformed fields")
  }
  if (registry.available !== true || registry.complete !== true) {
    partial = true
    diagnostic.push(...(registryReasons.length ? registryReasons.map((reason) => `secondmate registry: ${reason}`) : ["secondmate registry is incomplete"]))
  }
  if (registry.input_truncated === true || registry.records_truncated === true) {
    partial = true
    diagnostic.push("secondmate registry is truncated")
  }
  if (objects(registry.records).length !== requiredArray(registry, "records").length) {
    partial = true
    diagnostic.push("secondmate registry contains malformed records")
  }
  const totalRegistered = requiredNumber(current, "total_registered")
  const total = requiredNumber(current, "total")
  const shown = requiredNumber(current, "shown")
  const truncated = requiredNumber(current, "truncated")
  const rawCurrentRecords = requiredArray(current, "records")
  if (![totalRegistered, total, shown, truncated].every(nonNegativeInteger)
    || totalRegistered !== total || shown !== rawCurrentRecords.length || total !== shown + truncated) {
    partial = true
    diagnostic.push("secondmate current totals are inconsistent")
  }
  if (truncated > 0) {
    partial = true
    diagnostic.push(`secondmate current omitted ${truncated} registered homes`)
  }

  const sanitized = sanitizeSecondmateRecords(rawCurrentRecords, diagnostic)
  if (sanitized.partial) partial = true
  const currentRecords = sanitized.records
  const remote = secondmateItems(currentRecords, diagnostic)
  for (const summary of currentRecords) {
    const provenance = object(summary.provenance)
    const status = text(object(summary.freshness)?.status)
    if (text(provenance?.selected) !== "structured-home" || text(provenance?.trust) !== "complete") partial = true
    if (objects(summary.omitted).some((entry) => (finite(entry.count) ?? 0) > 0)) partial = true
    const normalized = fresh(status)
    overallFreshness = aggregateFreshness(overallFreshness, normalized)
  }
  for (const key of ["truncated", "unreadable", "partial"]) {
    const homes = strings(landed[key])
    if (homes.length) {
      partial = true
      diagnostic.push(`secondmate landed ${key}: ${homes.join(", ")}`)
    }
  }

  return {
    availability: "available",
    completeness: partial ? "partial" : "complete",
    freshness: overallFreshness,
    observedAt: generatedAt,
    diagnostic: [...new Set(diagnostic)].slice(0, 256),
    home: configuredHome,
    root: configuredRoot,
    workItems: [...mainItems(configuredHome, generatedAt, backlog, tasks), ...remote.items],
    homes: remote.homes,
  }
}
