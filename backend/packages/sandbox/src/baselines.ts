import { PROMPT_VERSIONS, promptVersionLabel, systemPromptFor } from '@cat-factory/agents'
import type { SandboxPromptVersion } from '@cat-factory/kernel'
import type { SandboxTaskType } from './rubrics.js'

// The Sandbox's catalog of testable agent kinds. Baselines are NOT stored in the DB —
// they are read live from `@cat-factory/agents` so they always reflect current source
// (the "all currently available prompts as baseline" surface). Each entry declares the
// agent's execution bucket (inline LLM vs container checkout — mirrors the server's
// `CONTAINER_KINDS`) and the grading rubric the judge should use for it.
//
// This is a deliberately curated starting set that maps cleanly onto the three shipped
// rubrics and the version-controlled baseline prompts. Adding a kind is one entry here.

export type SandboxAgentBucket = 'inline' | 'container'

export interface SandboxAgentKindMeta {
  /** The agent kind (matches `AgentKind` strings used across the product). */
  agentKind: string
  /** A short human label for the Sandbox prompt browser. */
  label: string
  /** Inline kinds run a single LLM call; container kinds need a real checkout. */
  bucket: SandboxAgentBucket
  /** Which rubric the judge grades this kind's output against. */
  rubric: SandboxTaskType
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
    rubric: 'requirement-review',
    basePromptId: 'requirement-review',
  },
  {
    agentKind: 'clarity-review',
    label: 'Clarity (bug-report) review',
    bucket: 'inline',
    rubric: 'requirement-review',
    basePromptId: 'clarity-review',
  },
  {
    agentKind: 'reviewer',
    label: 'Code reviewer',
    bucket: 'inline',
    rubric: 'code-review',
    basePromptId: 'review',
  },
  {
    agentKind: 'coder',
    label: 'Coder (implementation)',
    bucket: 'container',
    rubric: 'implementation',
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

/** The current shipped system-prompt text + `id@vN` label for a catalog kind. */
export function baselinePromptText(meta: SandboxAgentKindMeta): { text: string; label: string } {
  if (meta.basePromptId && meta.basePromptId in PROMPT_VERSIONS) {
    const versioned = PROMPT_VERSIONS[meta.basePromptId as keyof typeof PROMPT_VERSIONS]
    return { text: versioned.text, label: promptVersionLabel(versioned.id, versioned.version) }
  }
  return { text: systemPromptFor(meta.agentKind), label: promptVersionLabel(meta.agentKind, 1) }
}

/**
 * Enumerate every shipped baseline as a synthetic (un-persisted) {@link SandboxPromptVersion}.
 * These are version 0, origin `baseline`, with no parent/lineage of their own — the prompt
 * browser groups them by agent kind and offers "clone" to start an editable candidate lineage.
 */
export function listBaselines(now: number): SandboxPromptVersion[] {
  return SANDBOX_AGENT_KINDS.map((meta) => {
    const { text, label } = baselinePromptText(meta)
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
