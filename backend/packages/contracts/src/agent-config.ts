import * as v from 'valibot'
import { agentKindSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Agent configuration-contribution contracts.
//
// Agents (built-in or custom) may *contribute* task-level configuration
// parameters they care about — e.g. the `tester` agent contributes whether it
// runs the suite against an ephemeral environment or stands the dependencies up
// locally. When a pipeline is selected for a task, the union of the contributions
// of that pipeline's agent kinds is surfaced as editable fields on task creation
// and in the inspector. Each value is editable until the contributing agent's
// pipeline step starts, at which point it freezes.
//
// The descriptor catalog is STATIC metadata derived from the registered agent
// kinds (see `@cat-factory/agents` `configContributionsFor`), attached to the
// workspace snapshot. The selected VALUES live on the block (`Block.agentConfig`),
// a plain id→value map. This mirrors how the model/fragment/merge-preset catalogs
// are served read-only while the per-block selection is persisted on the block.
// ---------------------------------------------------------------------------

/** One selectable choice for a `select`-typed config descriptor. */
export const agentConfigOptionSchema = v.object({
  /** The value persisted on the block when this option is chosen. */
  value: v.pipe(v.string(), v.minLength(1)),
  /** Human label shown in the picker. */
  label: v.string(),
})
export type AgentConfigOption = v.InferOutput<typeof agentConfigOptionSchema>

/**
 * A single configuration parameter an agent kind contributes. `id` is a stable,
 * globally-unique key (conventionally namespaced by the kind, e.g.
 * `tester.environment`) used both as the descriptor key and as the key under
 * which the chosen value is stored in {@link agentConfigValuesSchema}. `type` is a
 * picklist for forward-compatibility — only `select` exists today, but a future
 * `text`/`number`/`boolean` descriptor slots in here without a shape change.
 */
export const agentConfigDescriptorSchema = v.object({
  /** Stable, globally-unique id, e.g. `tester.environment`. Also the value-map key. */
  id: v.pipe(v.string(), v.minLength(1)),
  /** The agent kind that contributes (and owns the freeze of) this config. */
  agentKind: agentKindSchema,
  /** Human label shown next to the field. */
  label: v.string(),
  /** One-line explanation shown under the field. */
  description: v.string(),
  /** The control type. Only `select` today; designed to grow. */
  type: v.picklist(['select']),
  /** The choices for a `select` descriptor. */
  options: v.array(agentConfigOptionSchema),
  /** The value used when the task has made no explicit choice. */
  default: v.pipe(v.string(), v.minLength(1)),
})
export type AgentConfigDescriptor = v.InferOutput<typeof agentConfigDescriptorSchema>

/** The full catalog of config descriptors, attached to the workspace snapshot. */
export const agentConfigCatalogSchema = v.array(agentConfigDescriptorSchema)
export type AgentConfigCatalog = v.InferOutput<typeof agentConfigCatalogSchema>

/**
 * The selected configuration values on a block: a plain map from descriptor id to
 * the chosen value. Sparse — only ids the user has explicitly set are present;
 * everything else resolves to the descriptor's `default` at read time.
 */
// Keys are descriptor ids (e.g. `tester.environment`) and values are short option
// values; both are length-capped so a stray client can't persist an unbounded map.
// Values are NOT validated against the descriptor catalog here (the contracts layer
// can't see the runtime-registered descriptors) — `resolveAgentConfigValue` falls
// back to the descriptor default for any unknown/invalid value at read time.
export const agentConfigValuesSchema = v.record(
  v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  v.pipe(v.string(), v.maxLength(400)),
)
export type AgentConfigValues = v.InferOutput<typeof agentConfigValuesSchema>

/** Parse-or-throw a block's stored agent-config values. */
export function parseAgentConfigValues(value: unknown): AgentConfigValues {
  return v.parse(agentConfigValuesSchema, value)
}

/**
 * Resolve a single descriptor's effective value for a block: the explicit choice
 * if present and valid, else the descriptor's default.
 */
export function resolveAgentConfigValue(
  descriptor: AgentConfigDescriptor,
  values: AgentConfigValues | undefined,
): string {
  const chosen = values?.[descriptor.id]
  if (chosen && descriptor.options.some((o) => o.value === chosen)) return chosen
  return descriptor.default
}
