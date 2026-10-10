import type { AgentConfigDescriptor, AgentKind } from '@cat-factory/kernel'
import type { AgentKindRegistry } from './registry.js'

// Built-in agent config contributions. An agent kind declares the task-level
// parameters it cares about here; the union over a pipeline's kinds is what the
// task-creation form and inspector render (and freeze once the owning step runs).
// Custom kinds contribute the same way via `registerAgentKind({ configContributions })`.

/** The acceptance/e2e execution target: project CI, or the ephemeral env. */
export const PLAYWRIGHT_E2E_TARGET_CONFIG_ID = 'playwright.e2eTarget'

/** The Coder's implementation-fork decision tri-state (auto / always / off). */
export const CODER_FORK_DECISION_CONFIG_ID = 'coder.forkDecision'

/**
 * The bugfix reproduction-proof tri-state (auto / always / off), read by the engine's
 * `resolveReproductionTriState`.
 *
 * Contributed as a task-facing descriptor only now that the whole feature is user-visible: the
 * verification phase runs in the harness (Phase B) and its verdict is published on the pull
 * request and in the step panel (Phases C/D). Offering the control earlier would have promised
 * behaviour that did not exist.
 *
 * `always` still resolves identically to `auto` — the divergence arrives with the tracker-issue
 * gating (the initiative's D2), which is why the two options say what each MEANS rather than
 * pretending to differ today: `auto` is the honest default, and `always` is the value a caller
 * pins so the behaviour does not change under it when that gating lands.
 */
export const CODER_REPRODUCTION_PROOF_CONFIG_ID = 'coder.reproductionProof'

const BUILTIN_CONFIG_CONTRIBUTIONS: Partial<Record<AgentKind, AgentConfigDescriptor[]>> = {
  coder: [
    {
      id: CODER_FORK_DECISION_CONFIG_ID,
      agentKind: 'coder',
      label: 'Implementation-fork decision',
      description:
        'Surface materially different implementation approaches before the Coder writes code and park for a human choice. `auto` gates on the task risk policy; `always` proposes regardless; `off` never proposes.',
      type: 'select',
      options: [
        { value: 'auto', label: 'Auto (gate on risk policy)' },
        { value: 'always', label: 'Always propose' },
        { value: 'off', label: 'Off' },
      ],
      default: 'auto',
    },
    {
      id: CODER_REPRODUCTION_PROOF_CONFIG_ID,
      agentKind: 'coder',
      label: 'Reproduction proof',
      description:
        'Run the reproduction test the run declared against BOTH the pre-fix tree and the finished one, and publish the two results on the pull request: only failing-then-passing proves the fix. `auto` runs it whenever the pipeline produced a reproduction declaration; `always` pins that behaviour for this task; `off` never runs it. A failed proof never fails the run, it is reported as unproven.',
      type: 'select',
      options: [
        { value: 'auto', label: 'Auto (whenever the run declared a reproduction)' },
        { value: 'always', label: 'Always, when a reproduction is declared' },
        { value: 'off', label: 'Off' },
      ],
      default: 'auto',
    },
  ],
  playwright: [
    {
      id: PLAYWRIGHT_E2E_TARGET_CONFIG_ID,
      agentKind: 'playwright',
      label: 'E2E execution target',
      description:
        'Where the acceptance / end-to-end tests run: in the project CI (GitHub Actions), or against the provisioned ephemeral environment.',
      type: 'select',
      options: [
        { value: 'ci', label: 'Project CI (GitHub Actions)' },
        { value: 'ephemeral', label: 'Ephemeral environment' },
      ],
      default: 'ci',
    },
  ],
}

/**
 * The config descriptors an agent kind contributes: the built-in ones plus any a
 * deployment registered for the kind. Empty for kinds that contribute none.
 */
export function configContributionsFor(
  kind: AgentKind,
  registry: AgentKindRegistry,
): AgentConfigDescriptor[] {
  const builtin = BUILTIN_CONFIG_CONTRIBUTIONS[kind] ?? []
  const registered = registry.configContributions(kind)
  return registered.length ? [...builtin, ...registered] : builtin
}

/**
 * The deduplicated catalog of config descriptors contributed across a set of agent
 * kinds (e.g. all the kinds used by a workspace's pipelines), keyed by descriptor
 * id (first contribution wins). This is what the workspace snapshot carries.
 */
export function configContributionCatalog(
  kinds: Iterable<AgentKind>,
  registry: AgentKindRegistry,
): AgentConfigDescriptor[] {
  const byId = new Map<string, AgentConfigDescriptor>()
  for (const kind of kinds) {
    for (const descriptor of configContributionsFor(kind, registry)) {
      if (!byId.has(descriptor.id)) byId.set(descriptor.id, descriptor)
    }
  }
  return [...byId.values()]
}
