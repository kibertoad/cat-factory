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
 * A body as the handler of the task type that wrote it decodes it, or undefined when it does not
 * parse. A row with no handler in this process is served as stored, since showing it needs no
 * understanding of it.
 */
export function decodeOutcomeBody(
  modules: ProjectKindModuleRegistry,
  row: ProjectOutcomeRow,
  raw: unknown,
): unknown {
  const handler = row.taskType === null ? undefined : modules.handler(row.taskType)
  return handler ? handler.parseOutcome(row.schemaVersion, raw) : raw
}

/** A stored outcome decoded by its handler. Throws on a body that does not parse. */
export function decodeOutcome(
  modules: ProjectKindModuleRegistry,
  { row, json }: { row: ProjectOutcomeRow; json: string },
): DecodedProjectOutcome {
  const body = decodeOutcomeBody(modules, row, JSON.parse(json) as unknown)
  if (body === undefined) throw new Error(`Outcome '${row.id}' holds an unreadable body`)
  return { ...outcomeMetaOf(row), taskType: row.taskType, body }
}
