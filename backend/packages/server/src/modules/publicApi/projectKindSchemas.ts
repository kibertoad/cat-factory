import type { ProjectKindSchemas } from '@cat-factory/contracts'
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

/** What `GET /api/v1/project-kinds/{kind}` serves for a kind's schemas: null where it has none. */
export function kindSchemas(schemas: ProjectKindSchemas | undefined): {
  spec: JsonSchema | null
  outcome: JsonSchema | null
  view: JsonSchema | null
} {
  return {
    spec: convert(schemas?.spec),
    outcome: convert(schemas?.outcome),
    view: convert(schemas?.view),
  }
}
