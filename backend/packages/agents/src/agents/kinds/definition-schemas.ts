import { HARNESS_KINDS, type McpServerDefinition } from '@cat-factory/kernel'
import * as v from 'valibot'
import type { BundledSkillDefinition, NormalizedSkillRefs } from './capabilities.js'

// ---------------------------------------------------------------------------
// The SHAPE of an agent kind's capability definitions, as valibot schemas. A definition is
// authored in TypeScript, but nothing stops a JS-authored or config-loaded one from carrying the
// wrong type (`env: { PORT: 3000 }`, `label: null`), and two places must refuse it:
//
//   - boot validation, so a deployment with a malformed definition fails at startup, naming the
//     definition and the field (`validateRegistrations`);
//   - the mothership-mode node, which reads the definitions over `GET /internal/agent-kinds` and
//     must never hand the harness a value it cannot write (`@cat-factory/server`'s
//     `agentKindsWire.ts`).
//
// One schema per definition, held EQUAL to the domain type at compile time (`Exactly` below), so a
// field that is added, removed, narrowed, widened or moved between required and optional fails to
// compile here until the schema is updated.
// ---------------------------------------------------------------------------

/**
 * A type rewritten as plain nested objects and arrays, so an intersection (`A & { b: B }`) and the
 * object type it spells compare as the same type. Optional modifiers are kept.
 */
type Flat<T> = T extends readonly (infer U)[]
  ? Flat<U>[]
  : T extends object
    ? { [K in keyof T]: Flat<T[K]> }
    : T

/** True only when `A` and `B` are the same type (not merely assignable either way). */
export type Equals<A, B> =
  (<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false

/**
 * A compile-time assertion that a schema's output IS the domain type it checks:
 * `exactly<v.InferOutput<typeof schema>, Type>(true)` fails to compile on any difference.
 */
export function exactly<A, B>(_proof: Equals<A, B>): void {}

/** A catalog skill reference, as the engine resolves it (`normalizeSkillRefs`). */
export const catalogSkillRefSchema = v.object({ skillId: v.string(), optional: v.boolean() })

/** A bundled skill: the directory name, the frontmatter, the body, and each resource file. */
export const bundledSkillDefinitionSchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
  instructions: v.string(),
  resources: v.optional(v.array(v.object({ relPath: v.string(), content: v.string() }))),
})

/**
 * A string-to-string map. `v.record` alone also accepts an array (and outputs a fresh object, so a
 * check placed AFTER it never sees the array), which the harness would mis-render. So the array is
 * refused first.
 */
const stringMap = v.pipe(
  v.custom<unknown>((value) => !Array.isArray(value), 'Expected an object, not an array'),
  v.record(v.string(), v.string()),
)

const secretRefSchema = v.object({
  key: v.string(),
  envName: v.optional(v.string()),
  header: v.optional(v.string()),
  headerTemplate: v.optional(v.string()),
  required: v.optional(v.boolean()),
  usage: v.optional(v.string()),
})

const oauthConfigSchema = v.object({
  grant: v.picklist(['authorization_code', 'client_credentials']),
  clientId: v.string(),
  clientSecretKey: v.optional(v.string()),
  authorizationUrl: v.optional(v.string()),
  tokenUrl: v.optional(v.string()),
  scopes: v.optional(v.array(v.string())),
  resource: v.optional(v.string()),
  header: v.optional(v.string()),
  headerTemplate: v.optional(v.string()),
})

/** A tool server: an id to name its tools under, a transport to reach it, and what the harness renders. */
export const mcpServerDefinitionSchema = v.object({
  id: v.string(),
  label: v.optional(v.string()),
  guidance: v.optional(v.string()),
  transport: v.variant('kind', [
    v.object({
      kind: v.literal('stdio'),
      command: v.string(),
      args: v.optional(v.array(v.string())),
      env: v.optional(stringMap),
    }),
    v.object({ kind: v.literal('http'), url: v.string(), headers: v.optional(stringMap) }),
  ]),
  allowedTools: v.optional(v.array(v.string())),
  harnesses: v.optional(v.array(v.picklist(HARNESS_KINDS))),
  secretKeys: v.optional(v.array(secretRefSchema)),
  oauth: v.optional(oauthConfigSchema),
})

exactly<v.InferOutput<typeof catalogSkillRefSchema>, NormalizedSkillRefs['catalog'][number]>(true)
exactly<v.InferOutput<typeof bundledSkillDefinitionSchema>, BundledSkillDefinition>(true)
exactly<v.InferOutput<typeof mcpServerDefinitionSchema>, McpServerDefinition>(true)

/**
 * What is wrong with a definition, one line per issue, each naming the field by its dot path
 * (`transport.env.PORT: Invalid type: Expected string but received 3000`). Empty when it is valid.
 */
export function definitionIssues(
  schema: typeof bundledSkillDefinitionSchema | typeof mcpServerDefinitionSchema,
  definition: unknown,
): string[] {
  const result = v.safeParse(schema, definition)
  if (result.success) return []
  return result.issues.map((issue) => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
}
