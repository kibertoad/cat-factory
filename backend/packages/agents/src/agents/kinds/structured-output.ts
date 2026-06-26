import * as v from 'valibot'
import type { AgentOutputSpec } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Schema-driven structured output for custom agent kinds.
//
// A `container-explore` / `inline` kind whose deliverable is JSON used to declare a
// free-string `output.shapeHint` and then hand-write a lenient `coerce(value: unknown)` that
// never throws — the same boilerplate in every custom-agent package, with no relation between
// the hint string and the actual parse. `defineStructuredOutput(schema)` collapses both into
// one valibot schema: it DERIVES the `AgentOutputSpec` (the `shapeHint` fed to the harness
// repair call) AND returns the typed `parse`/`safeParse` the post-op / step-resolver consume.
//
// This lives in `@cat-factory/agents` (not kernel) because kernel cannot depend on valibot —
// it imports only `@cat-factory/contracts` + `ai`. Kernel's `AgentStepSpec.output` keeps its
// plain-string shape; only the derived `AgentOutputSpec` (strings/booleans) crosses into it.
// ---------------------------------------------------------------------------

/** A schema-backed structured-output descriptor: the engine spec + a typed parser. */
export interface StructuredOutput<T> {
  /**
   * The {@link AgentOutputSpec} to attach to a kind's `agent.output` — `kind: 'structured'`
   * plus the derived (or overridden) `shapeHint` and the repair / fail-on-unusable flags.
   * `registerAgentKind` spreads this onto `agent.output` automatically when the author
   * declared `structuredOutput` and didn't set `agent.output` by hand.
   */
  readonly spec: AgentOutputSpec
  /** Strict parse-or-throw — for callers that must reject a malformed reply. */
  parse(value: unknown): T
  /**
   * Lenient parse: returns the validated value, or `undefined` when it can't be parsed (so a
   * post-op's existing "no-op when nothing parseable" guard — `if (!parsed) return` — holds).
   * Falls back through valibot's `v.fallback`/`v.optional` defaults, so a schema built with
   * those degrades gracefully exactly like the old hand-written coercer did.
   */
  safeParse(value: unknown): T | undefined
}

/** Options for {@link defineStructuredOutput}. */
export interface StructuredOutputOptions {
  /**
   * Override the auto-derived `shapeHint`. Supply this when the schema walker's hint is worse
   * than a hand-written one (e.g. a deeply nested or unusual shape) — it's the same string
   * the harness's one-shot repair call sees on a malformed first reply.
   */
  shapeHint?: string
  /** Attempt the one-shot structured-output repair on a malformed reply (default: true). */
  repair?: boolean
  /**
   * Fail the run loudly when the agent's FINAL answer is unusable (truncated / empty) instead
   * of laundering it through repair. Opt-in for kinds whose deliverable IS the JSON returned.
   */
  failOnUnusableFinal?: boolean
}

/**
 * Define a kind's structured output from a valibot schema: derive the engine
 * {@link AgentOutputSpec} and a typed `parse`/`safeParse`. The inferred output type `T` flows
 * through, so a post-op consuming `safeParse(ctx.result.custom)` is fully typed.
 */
export function defineStructuredOutput<S extends v.GenericSchema>(
  schema: S,
  opts: StructuredOutputOptions = {},
): StructuredOutput<v.InferOutput<S>> {
  const shapeHint = opts.shapeHint ?? describeSchema(schema)
  const spec: AgentOutputSpec = {
    kind: 'structured',
    shapeHint,
    repair: opts.repair ?? true,
    ...(opts.failOnUnusableFinal ? { failOnUnusableFinal: true } : {}),
  }
  return {
    spec,
    parse: (value) => v.parse(schema, value),
    safeParse: (value) => {
      const result = v.safeParse(schema, value)
      return result.success ? result.output : undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Best-effort schema → compact shape-hint walker. Covers the valibot shapes used in-repo
// (object / array / picklist / literal / number / string / boolean / optional / nullable /
// fallback). Anything it doesn't recognise renders as its `type` name — and an author can
// always pass an explicit `shapeHint` to bypass the walker entirely.
// ---------------------------------------------------------------------------

interface AnySchema {
  type?: string
  entries?: Record<string, AnySchema>
  item?: AnySchema
  wrapped?: AnySchema
  options?: readonly unknown[]
  literal?: unknown
}

function describeSchema(schema: v.GenericSchema): string {
  return describe(schema as unknown as AnySchema, 0)
}

function describe(node: AnySchema, depth: number): string {
  if (!node || typeof node !== 'object') return 'any'
  switch (node.type) {
    case 'object': {
      const entries = node.entries ?? {}
      // Guard against pathological depth so a recursive schema can't blow the hint up.
      if (depth > 4) return '{ … }'
      const parts = Object.entries(entries).map(
        ([key, value]) => `"${key}": ${describe(value, depth + 1)}`,
      )
      return `{ ${parts.join(', ')} }`
    }
    case 'array':
      return `[${node.item ? describe(node.item, depth + 1) : 'any'}]`
    case 'optional':
    case 'nullable':
    case 'nullish':
    case 'fallback':
      // Unwrap the inner schema; the field's presence is already conveyed by the object hint.
      return node.wrapped ? describe(node.wrapped, depth) : 'any'
    case 'picklist':
    case 'enum':
      return (node.options ?? []).map((o) => JSON.stringify(o)).join('|') || 'string'
    case 'literal':
      return JSON.stringify(node.literal)
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    default:
      return node.type ?? 'any'
  }
}
