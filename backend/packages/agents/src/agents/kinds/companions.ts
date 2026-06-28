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
  /**
   * HOW the companion runs its review.
   *   - `inline` (default): a one-shot LLM call that grades the producer's reported output
   *     text — adequate when the producer's deliverable IS that text (e.g. the architect's
   *     prose plan).
   *   - `container-explore`: a read-only container that CLONES the producer's PR branch and
   *     reads the ACTUAL repository (the changed files / the full document) with tools before
   *     judging, returning the verdict as structured JSON. Required whenever the producer's
   *     real deliverable is committed to the repo rather than reported in its reply — a code
   *     reviewer that only sees a summary is useless, and the same is true of a document
   *     reviewer. The engine dispatches these through the same async container path the
   *     coder/merger use (see `CompositeAgentExecutor` / `ContainerAgentExecutor`) and resolves
   *     the verdict in `recordStepResult` → `CompanionController.resolveContainerVerdict`.
   */
  surface?: 'inline' | 'container-explore'
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
    // It runs in a container so it reads the ACTUAL diff / repository, not just the
    // coder's summary reply — a code review of a summary is worthless.
    kind: 'reviewer',
    targets: ['coder'],
    defaultThreshold: DEFAULT_COMPANION_THRESHOLD,
    reviews: 'code change for correctness, quality, security and risk',
    surface: 'container-explore',
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
    // Runs in a container so it reads the ACTUAL committed Markdown (the whole point of the
    // document pipeline), not the writer's summary reply.
    surface: 'container-explore',
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

/**
 * Whether `kind` is a companion that reviews in a CONTAINER (cloning the producer's PR
 * branch and reading the real repository) rather than inline. The single source of truth
 * the executor uses to route the companion through the container path, the engine uses to
 * keep it off the inline companion path, and the prompt uses to tell it to read the
 * checkout. False for non-companions and inline companions.
 */
export function isContainerBackedCompanion(kind: AgentKind): boolean {
  return BY_KIND.get(kind)?.surface === 'container-explore'
}
