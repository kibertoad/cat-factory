import { PROMPT_VERSIONS, promptVersionLabel, shippedBasePromptFor } from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  SandboxAgentBucket,
  SandboxFixtureKind,
  SandboxRunMode,
  SandboxUnsupportedReason,
} from '@cat-factory/contracts'
import type { SandboxPromptVersion } from '@cat-factory/kernel'
import type { SandboxTaskType } from './rubrics.js'

// The Sandbox's catalog of testable agent kinds. Baselines are NOT stored in the DB —
// they are read live from `@cat-factory/agents` so they always reflect current source
// (the "all currently available prompts as baseline" surface). Each entry declares how
// PRODUCTION dispatches the kind, how the SANDBOX runs a cell for it, the grading rubric
// the judge should use, and the fixture kinds it is exercised against.
//
// Adding a kind is one entry here. What it must be able to answer is on
// `SandboxAgentKindMeta` below; the two execution fields are deliberately separate.

// `SandboxAgentBucket`, `SandboxRunMode` and `SandboxUnsupportedReason` are the contracts'
// picklists rather than types restated here, because the SPA has to render all three and cannot see
// this package. Conflating the first two is what let the catalog advertise the `coder` as a testable
// kind whose every draft experiment then 400-ed at create, and simultaneously describe the
// `reviewer` as `inline` when production gives it a real checkout.
export type { SandboxAgentBucket, SandboxRunMode, SandboxUnsupportedReason }

export interface SandboxAgentKindMeta {
  /** The agent kind (matches `AgentKind` strings used across the product). */
  agentKind: string
  /** A short human label for the Sandbox prompt browser. */
  label: string
  /** How PRODUCTION dispatches this kind. */
  bucket: SandboxAgentBucket
  /** How the SANDBOX runs a cell for it; `unsupported` ⇒ {@link unsupportedReason} says why. */
  sandboxRun: SandboxRunMode
  /**
   * Why the Sandbox cannot run this kind, as a bounded CODE. Non-null exactly when
   * `sandboxRun === 'unsupported'` (asserted in `baselines.test.ts`), and the SINGLE place the
   * refusal is DECIDED: the create endpoint, the run-driver and the SPA's excluded-kind note all
   * read this one value rather than each carrying its own copy.
   *
   * A code rather than the sentence itself because the two readers need different text in
   * different languages: `sandboxAdmission.ts` turns it into the API refusal an operator sees, and
   * the SPA maps it to a translated line under the field. Prose here could only ever reach the
   * browser in English.
   */
  unsupportedReason: SandboxUnsupportedReason | null
  /** Which rubric the judge grades this kind's output against. */
  rubric: SandboxTaskType
  /**
   * The fixture kinds this agent is exercised against (the fixture↔kind mapping the UI
   * filters the library by). Source of truth here so the frontend reads it off the catalog
   * instead of re-encoding the mapping in a parallel switch that can silently drift.
   */
  fixtureKinds: readonly SandboxFixtureKind[]
  /**
   * The version-controlled baseline prompt id (a `PROMPT_VERSIONS` key) this kind's
   * system prompt comes from. When null, the baseline text is read from
   * `systemPromptFor(agentKind)` and labelled `<kind>@v1`.
   */
  basePromptId: string | null
}

/** The testable-kind catalog. Ordered for stable display (inline-first, then container). */
export const SANDBOX_AGENT_KINDS: readonly SandboxAgentKindMeta[] = [
  {
    agentKind: 'requirements-review',
    label: 'Requirements review',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'requirement-review',
    fixtureKinds: ['requirements'],
    basePromptId: 'requirement-review',
  },
  {
    // Bug-report triage, graded on `bug-triage` rather than `requirement-review`. The two share an
    // output shape and nothing else: a triage's best moves are splitting conflated symptoms and
    // asking about recovery, and `requirement-review`'s `product_scope` dimension actively docked
    // it for the session/cookie and load-balancer hypotheses that ARE the skill here.
    agentKind: 'clarity-review',
    label: 'Clarity (bug-report) review',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'bug-triage',
    fixtureKinds: ['clarity'],
    basePromptId: 'clarity-review',
  },
  {
    // The Requirement Writer: for each requirements-review finding it recommends a concrete answer
    // and self-reports `groundedIn` + `confidence`. Those two fields are what an UNATTENDED run
    // acts on (ADR 0053), which is why they get rubric dimensions of their own.
    //
    // Driven by `IterativeReviewService` as an inline engine kind (see
    // `INLINE_ENGINE_SYSTEM_PROMPTS`), so its baseline is the numbered `requirement-writer` prompt.
    agentKind: 'requirements-writer',
    label: 'Requirement writer (recommended answers)',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'answer-recommendation',
    fixtureKinds: ['answer-recommendation'],
    basePromptId: 'requirement-writer',
  },
  {
    // Predictive triage: three 0..1 axes plus a rationale, run inline before any design work. Its
    // scores gate the expensive consensus path and surface on the card, so calibration is the
    // product behaviour under test. No numbered baseline prompt: the role text is read live.
    agentKind: 'task-estimator',
    label: 'Task estimator (triage scores)',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'estimation',
    fixtureKinds: ['estimation'],
    basePromptId: null,
  },
  {
    // The code `reviewer` is the coder's COMPANION, and a companion's prompt wins over every
    // built-in track (`baseSystemPromptFor`), so its baseline is NOT the numbered `review`
    // phase prompt — naming that id here showed a candidate the wrong text to fork from and
    // graded it against a baseline production never sends. No numbered baseline prompt: the
    // text is read live from the companion track, exactly like `architect-companion` below.
    //
    // `bucket: 'container'` is the truth: in production this companion clones the producer's PR
    // branch and reads the real files (`isContainerBackedCompanion`), and its composed system
    // prompt says so. The Sandbox still runs it inline, so the run-driver STATES the missing
    // checkout in the task input and the fixture hands the change over as injected context files,
    // which is the same seam production uses for an inline caller with no filesystem.
    agentKind: 'reviewer',
    label: 'Code reviewer',
    bucket: 'container',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'code-review',
    fixtureKinds: ['code-review'],
    basePromptId: null,
  },
  {
    // Reviews an `architect`'s design proposal (the architect-companion grades it). Graded on
    // `architecture-review`: a design critique's whole job is the TECHNICAL layer, so
    // `requirement-review` was the wrong rubric in the one way that mattered.  No numbered
    // baseline prompt: the text is read live from `systemPromptFor('architect-companion')`.
    agentKind: 'architect-companion',
    label: 'Architecture-proposal review',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'architecture-review',
    fixtureKinds: ['architecture'],
    basePromptId: null,
  },
  {
    // The coder's deliverable is a pushed commit, so grading it needs a real container run against
    // a seed repository the deployment owns; an inline cell can only grade text. Stated as that
    // specific route rather than "not yet supported" because the alternatives are genuinely
    // different work and a reader deciding whether to wait needs to know which one is missing. See
    // `docs/initiatives/sandbox-coverage-expansion.md`.
    agentKind: 'coder',
    label: 'Coder (implementation)',
    bucket: 'container',
    sandboxRun: 'unsupported',
    unsupportedReason: 'container-run-required',
    rubric: 'implementation',
    fixtureKinds: ['repo-feature', 'repo-bug'],
    basePromptId: 'build',
  },
]

const BY_KIND = new Map<string, SandboxAgentKindMeta>(
  SANDBOX_AGENT_KINDS.map((m) => [m.agentKind, m]),
)

/** Metadata for a testable agent kind, or undefined if the kind is not in the catalog. */
export function sandboxKindMeta(agentKind: string): SandboxAgentKindMeta | undefined {
  return BY_KIND.get(agentKind)
}

/**
 * Whether a cell for this kind must TELL the candidate it has no checkout.
 *
 * True exactly for a kind production dispatches into a container but the Sandbox runs inline: its
 * composed system prompt was written for an agent holding a real clone and instructs it to diff the
 * branch and read the changed files. Left unsaid, the candidate is graded on failing to do
 * something impossible, which is the same defect as silently dropping a capability the prompt
 * promised. Derived from the two declared facts rather than carried as a third one they could
 * contradict.
 */
export function statesMissingCheckout(meta: SandboxAgentKindMeta): boolean {
  return meta.bucket === 'container' && meta.sandboxRun === 'inline'
}

/**
 * The current shipped system-prompt text + `id@vN` label for a catalog kind.
 *
 * The text is `shippedBasePromptFor`: the SAME unit a workspace prompt override holds and the
 * pipeline builder's editor shows, deliberately WITHOUT the surface directives, trait guidance or
 * (for a bespoke kind) the directives half the platform re-appends. That is what makes a sandbox
 * version and a workspace revision interchangeable: a candidate can be promoted to the live prompt,
 * and a live prompt can be dropped into a matrix, with no reinterpretation of what the text means.
 *
 * `PROMPT_VERSIONS` supplies only the LABEL. Reading the text off it instead was wrong for exactly
 * the inline ENGINE kinds: `PROMPT_VERSIONS['requirement-review'].text` is the COMPOSED prompt
 * (role plus directives), so a candidate cloned from it already carried the directives, and
 * promoting that candidate to the live prompt doubled them.
 *
 * The directives are re-applied at RUN time by `composedSystemPromptFor`, the same composition
 * production dispatch uses, so a candidate is still graded on what would actually be sent.
 */
export function baselinePromptText(
  meta: SandboxAgentKindMeta,
  registry: AgentKindRegistry,
): { text: string; label: string } {
  const versioned =
    meta.basePromptId && meta.basePromptId in PROMPT_VERSIONS
      ? PROMPT_VERSIONS[meta.basePromptId as keyof typeof PROMPT_VERSIONS]
      : undefined
  return {
    text: shippedBasePromptFor(meta.agentKind, registry),
    label: versioned
      ? promptVersionLabel(versioned.id, versioned.version)
      : promptVersionLabel(meta.agentKind, 1),
  }
}

/**
 * Enumerate every shipped baseline as a synthetic (un-persisted) {@link SandboxPromptVersion}.
 * These are version 0, origin `baseline`, with no parent/lineage of their own — the prompt
 * browser groups them by agent kind and offers "clone" to start an editable candidate lineage.
 */
export function listBaselines(now: number, registry: AgentKindRegistry): SandboxPromptVersion[] {
  return SANDBOX_AGENT_KINDS.map((meta) => {
    const { text, label } = baselinePromptText(meta, registry)
    return {
      id: `baseline:${meta.basePromptId ?? meta.agentKind}`,
      lineageId: `baseline:${meta.basePromptId ?? meta.agentKind}`,
      agentKind: meta.agentKind,
      name: label,
      origin: 'baseline',
      systemText: text,
      basePromptId: meta.basePromptId,
      version: 0,
      parentId: null,
      labels: [],
      createdAt: now,
      createdBy: null,
      archivedAt: null,
    }
  })
}
