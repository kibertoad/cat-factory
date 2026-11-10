import * as v from 'valibot'
import { capabilityCredentialKeySchema } from './capability-credentials.js'
import { projectKindIdSchema } from './projects.js'
import { taskTypeFieldDescriptorSchema } from './task-types.js'

// ---------------------------------------------------------------------------
// Project definitions: the versioned, org-authored template a project of some kind pins. The
// platform reads the envelope (key, version, credentials, targets, inputs, prompt additions) and
// treats `spec` as opaque: the project kind owns its shape and validates it. Design:
// `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

export const PROJECT_DEFINITION_TITLE_MAX = 200
export const PROJECT_DEFINITION_PROSE_MAX = 20_000
export const PROJECT_DEFINITION_SHORT_MAX = 2000

/**
 * A definition key is namespaced, `<namespace>:<name>`. A stored definition's namespace must be
 * its account's own, so the code-registered and stored key spaces never meet.
 */
export const projectDefinitionKeySchema = v.pipe(
  v.string(),
  v.regex(
    /^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,79}$/,
    'must be `<namespace>:<name>` in lowercase letters, digits and dashes',
  ),
)

/** The namespace half of a definition key. */
export function projectDefinitionNamespace(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

export const projectDefinitionVersionSchema = v.pipe(v.number(), v.integer(), v.minValue(1))

const title = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(PROJECT_DEFINITION_TITLE_MAX),
)

/** A link a human follows from the SPA, so a `javascript:` or `data:` URL can never pass. */
export const webUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.regex(/^https?:\/\//i, 'must be an http:// or https:// URL'),
)

export const projectCredentialKindSchema = v.picklist([
  'login',
  'api-token',
  'oauth-client',
  'secret',
])
export type ProjectCredentialKind = v.InferOutput<typeof projectCredentialKindSchema>

/** A credential a project's runs need, declared by NAME. The value lives in the credential store. */
export const projectCredentialSchema = v.object({
  key: capabilityCredentialKeySchema,
  kind: projectCredentialKindSchema,
  label: title,
  /** What the human does to obtain the credential from the vendor. */
  onboarding: v.optional(
    v.object({
      url: v.optional(webUrlSchema),
      instructions: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(PROJECT_DEFINITION_SHORT_MAX),
      ),
    }),
  ),
  /** False: the agent asks for it when it reaches the point of need. */
  requiredAtStart: v.boolean(),
})
export type ProjectCredential = v.InferOutput<typeof projectCredentialSchema>

/** An external system a project's runs reach. A credential is only ever sent to one of these. */
export const projectTargetSchema = v.object({
  baseUrl: v.pipe(
    v.string(),
    v.url(),
    v.check((url) => url.startsWith('https://'), 'a target must be https'),
  ),
  surface: v.picklist(['ui', 'api']),
})
export type ProjectTarget = v.InferOutput<typeof projectTargetSchema>

export function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) (seen.has(value) ? repeated : seen).add(value)
  return [...repeated]
}

/**
 * The envelope entries every definition carries. A kind that types its `spec` (and tightens any
 * other entry) spreads these into its own schema and applies `projectDefinitionChecks`, so the
 * envelope rules hold for every kind.
 */
export const projectDefinitionEntries = {
  /** The project kind this definition is for. */
  kind: projectKindIdSchema,
  key: projectDefinitionKeySchema,
  version: projectDefinitionVersionSchema,
  title,
  credentials: v.optional(v.array(projectCredentialSchema), []),
  targets: v.optional(v.array(projectTargetSchema), []),
  /** Per-project parameters, in the shared descriptor-form vocabulary. */
  inputs: v.optional(v.array(taskTypeFieldDescriptorSchema), []),
  /** Org steering appended to the named agent kind's prompt, as initiative presets do. */
  promptAdditions: v.optional(
    v.record(v.string(), v.pipe(v.string(), v.maxLength(PROJECT_DEFINITION_PROSE_MAX))),
    {},
  ),
  /** The kind's own content, opaque to the platform. */
  spec: v.unknown(),
}

interface EnvelopeLists {
  credentials: ReadonlyArray<{ key: string }>
  inputs: ReadonlyArray<{ key: string }>
}

/** The envelope's own rules, typed for the schema they are piped after. */
export function projectDefinitionChecks<T extends EnvelopeLists>() {
  return [
    v.check<T, string>(
      (d) => duplicateValues(d.credentials.map((c) => c.key)).length === 0,
      'credential keys must be unique',
    ),
    v.check<T, string>(
      (d) => duplicateValues(d.inputs.map((field) => field.key)).length === 0,
      'input keys must be unique',
    ),
  ] as const
}

const envelopeSchema = v.object(projectDefinitionEntries)

/** A versioned definition with an opaque `spec`. Immutable once published. */
export const projectDefinitionSchema = v.pipe(
  envelopeSchema,
  ...projectDefinitionChecks<v.InferOutput<typeof envelopeSchema>>(),
)
export type ProjectDefinition = v.InferOutput<typeof projectDefinitionSchema>
export type ProjectDefinitionInput = v.InferInput<typeof projectDefinitionSchema>

export type DefinitionParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] }

/** Every valibot issue as `path: message`. */
export function describeValibotIssues(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const path = v.getDotPath(issue)
    return path ? `${path}: ${issue.message}` : issue.message
  })
}

/** Validate a definition's envelope. Its `spec` is the kind's to validate. */
export function parseProjectDefinition(input: unknown): DefinitionParseResult<ProjectDefinition> {
  const result = v.safeParse(projectDefinitionSchema, input)
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, issues: describeValibotIssues(result.issues) }
}

/**
 * How a project kind validates the `spec` of its definitions. The kind supplies one; the
 * platform runs it at registration and at publish without knowing what the spec holds.
 */
export interface ProjectDefinitionSpecValidator {
  kind: string
  parseSpec(definition: ProjectDefinition): DefinitionParseResult<unknown>
}

/**
 * What a project pins: one definition version, its content hash (so a code-registered definition
 * edited in place refuses), and the values for the definition's inputs.
 */
export const projectPinSchema = v.object({
  projectId: v.string(),
  definitionKey: projectDefinitionKeySchema,
  definitionVersion: projectDefinitionVersionSchema,
  definitionHash: v.string(),
  inputs: v.optional(v.record(v.string(), v.unknown()), {}),
})
export type ProjectPin = v.InferOutput<typeof projectPinSchema>
