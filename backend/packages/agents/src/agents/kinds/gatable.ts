import type { AgentKind } from '@cat-factory/kernel'
import { BUILTIN_GATABLE_KINDS } from '@cat-factory/contracts'
import type { AgentKindRegistry } from './registry.js'

// The gatable-kind vocabulary itself lives in `@cat-factory/contracts`
// (`BUILTIN_GATABLE_KINDS`), with the full rationale for each entry and for the kinds
// deliberately left OUT. It is shared rather than declared here because the SPA's
// pipeline-health advisory re-derives the same verdict client-side and cannot see this package:
// when it carried its own copy, generalising the rule past companions left the advisory calling a
// SHIPPED built-in invalid and auto-opening a modal over the board.
//
// What stays here is the registry-aware lookup, which is backend-only.

export { BUILTIN_GATABLE_KINDS }

/**
 * Whether `kind` may carry estimate gating — its registered `gatable` flag when a deployment
 * registered the kind, else the built-in set.
 *
 * The registry lookup comes FIRST and is authoritative when present, mirroring
 * `registeredAgentTuning` / `webResearchHintFor`: a deployment that registers a kind owns the
 * answer for it. Built-in kinds are not registry entries (see `custom-agents.md` — the built-ins
 * are not migrated to the manifest model), so `registry.gatable(kind)` is `undefined` for every
 * one of them and the shared set is what answers.
 */
export function isGatableKind(kind: AgentKind, registry?: AgentKindRegistry): boolean {
  return registry?.gatable(kind) ?? BUILTIN_GATABLE_KINDS.has(kind)
}
