import type { AgentKind } from '@cat-factory/kernel'
import { DEFAULT_COMPANION_THRESHOLD } from '@cat-factory/contracts'

// Companion agents review the output of the immediately-preceding producer step,
// rate its overall quality (0..1) and — below the step's threshold — loop the
// producer back for automatic rework before a human is asked, failing the run once
// the rework budget is spent. Each companion declares the producer kinds it may be
// attached to (its allow-list) and a default threshold; both are configurable in the
// pipeline builder. A companion must run immediately after a step whose kind is in its
// `targets` — pipeline validation enforces that adjacency (see `assertValidCompanionPlacement`),
// so the nearest preceding target the engine reviews is always the immediate predecessor.

export interface CompanionDefinition {
  /** The companion's own agent kind. */
  kind: AgentKind
  /** Producer kinds this companion may review (allow-list for pipeline placement). */
  targets: AgentKind[]
  /** Default quality bar (0..1) a pipeline step uses when it sets no explicit threshold. */
  defaultThreshold: number
  /** Short label for the producer being reviewed, woven into the companion's prompt. */
  reviews: string
}

/** The built-in companion catalog. */
export const COMPANIONS: CompanionDefinition[] = [
  {
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: DEFAULT_COMPANION_THRESHOLD,
    reviews: 'solution design / architecture proposal',
  },
  {
    kind: 'spec-companion',
    targets: ['spec-writer'],
    defaultThreshold: DEFAULT_COMPANION_THRESHOLD,
    reviews:
      "specification increment's fidelity to the task requirements it was given and the " +
      'completeness of its acceptance-scenario coverage',
  },
  {
    // `reviewer` is the coder's companion: it directly challenges the builder's
    // output and can loop it back for rework. Auto-only by default (no human gate).
    kind: 'reviewer',
    targets: ['coder'],
    defaultThreshold: DEFAULT_COMPANION_THRESHOLD,
    reviews: 'code change for correctness, quality, security and risk',
  },
  {
    // `doc-reviewer` is the document writer's companion: it rates the drafted document and
    // loops the `doc-writer` back for rework below the threshold (the AI-to-AI convergence
    // loop of the document-authoring pipeline, before the human gate on this step).
    kind: 'doc-reviewer',
    targets: ['doc-writer'],
    defaultThreshold: DEFAULT_COMPANION_THRESHOLD,
    reviews:
      'document draft for completeness against the brief, clarity, accuracy and fitness of its ' +
      'structure for the document kind',
  },
]

const BY_KIND = new Map<string, CompanionDefinition>(COMPANIONS.map((c) => [c.kind, c]))

/** Whether `kind` is a companion agent (driven by the engine's companion review loop). */
export function isCompanionKind(kind: AgentKind): boolean {
  return BY_KIND.has(kind)
}

/** The companion definition for `kind`, or undefined if it is not a companion. */
export function companionFor(kind: AgentKind): CompanionDefinition | undefined {
  return BY_KIND.get(kind)
}

/** The producer kinds a companion may be attached to (empty if not a companion). */
export function companionTargets(kind: AgentKind): AgentKind[] {
  return BY_KIND.get(kind)?.targets ?? []
}
