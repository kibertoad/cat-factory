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
 * The outcome schema is its task handler's; a kind offering several handlers writes bodies of
 * several shapes, which one schema cannot state, so it is null there.
 */
export function kindSchemas(module: ProjectKindModule | undefined): {
  spec: JsonSchema | null
  outcome: JsonSchema | null
  view: JsonSchema | null
} {
  const only = module?.handlers.length === 1 ? module.handlers[0] : undefined
  return {
    spec: convert(module?.schemas?.spec),
    outcome: convert(only?.schemas?.outcome),
    view: convert(module?.schemas?.view),
  }
}
