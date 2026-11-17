import type { ProjectOutcomeMeta } from '@cat-factory/contracts'
import type {
  DecodedProjectOutcome,
  ProjectKindModuleRegistry,
  ProjectOutcomeRow,
} from '@cat-factory/kernel'

/** An outcome row's envelope as clients read it: without its body reference or its handler. */
export function outcomeMetaOf(row: ProjectOutcomeRow): ProjectOutcomeMeta {
  const { body: _ref, bodyBytes: _bytes, taskType: _taskType, ...meta } = row
  return meta
}

/**
 * The task type whose handler decodes `row` of a `kind` project, or null when no handler in this
 * process does (see `ProjectKindModuleRegistry.handlerOfOutcome`).
 */
export function outcomeTaskType(
  modules: ProjectKindModuleRegistry,
  kind: string,
  row: Pick<ProjectOutcomeRow, 'taskType'>,
): string | null {
  return modules.handlerOfOutcome(kind, row.taskType)?.taskType ?? null
}

/**
 * A stored outcome decoded by its handler, or undefined when its body is unreadable just now
 * (`json: null`), is not JSON, or does not parse. A row no handler in this process decodes is
 * served as stored, since showing it needs no understanding of it.
 */
export function tryDecodeOutcome(
  modules: ProjectKindModuleRegistry,
  kind: string,
  { row, json }: { row: ProjectOutcomeRow; json: string | null },
): DecodedProjectOutcome | undefined {
  if (json === null) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return undefined
  }
  const handler = modules.handlerOfOutcome(kind, row.taskType)
  const body = handler ? handler.parseOutcome(row.schemaVersion, raw) : raw
  if (body === undefined) return undefined
  return { ...outcomeMetaOf(row), taskType: handler?.taskType ?? null, body }
}

/** A stored outcome decoded by its handler. Throws on a body that does not parse. */
export function decodeOutcome(
  modules: ProjectKindModuleRegistry,
  kind: string,
  stored: { row: ProjectOutcomeRow; json: string },
): DecodedProjectOutcome {
  const decoded = tryDecodeOutcome(modules, kind, stored)
  if (!decoded) throw new Error(`Outcome '${stored.row.id}' holds an unreadable body`)
  return decoded
}
