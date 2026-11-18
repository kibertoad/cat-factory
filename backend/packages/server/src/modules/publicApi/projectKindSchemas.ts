import type { ProjectKindModule } from '@cat-factory/kernel'
import { toJsonSchema } from '@valibot/to-json-schema'
import type * as v from 'valibot'

type JsonSchema = Record<string, unknown>

/** The JSON Schemas of a kind's own shapes, converted once per schema and kept. */
const converted = new WeakMap<v.GenericSchema, JsonSchema>()

function convert(schema: v.GenericSchema | undefined): JsonSchema | null {
  if (!schema) return null
  let json = converted.get(schema)
  if (!json) {
    // A refinement (a check, a transform) has no JSON Schema form; the shape it refines does, and
    // the kind still applies the refinement when it parses.
    json = toJsonSchema(schema, { errorMode: 'ignore' }) as JsonSchema
    converted.set(schema, json)
  }
  return json
}

/**
 * What `GET /api/v1/project-kinds/{kind}` serves for a kind's schemas: null where it has none.
 * `outcomes` states each task handler's body by task type, which an outcome names. `outcome` is
 * the single handler's for a kind with one, and null for a kind with several, since one schema
 * cannot state bodies of several shapes.
 */
export function kindSchemas(module: ProjectKindModule | undefined): {
  spec: JsonSchema | null
  outcome: JsonSchema | null
  outcomes: Record<string, JsonSchema | null>
  view: JsonSchema | null
} {
  const handlers = module?.handlers ?? []
  const only = handlers.length === 1 ? handlers[0] : undefined
  return {
    spec: convert(module?.schemas?.spec),
    outcome: convert(only?.schemas?.outcome),
    outcomes: Object.fromEntries(handlers.map((h) => [h.taskType, convert(h.schemas?.outcome)])),
    view: convert(module?.schemas?.view),
  }
}
