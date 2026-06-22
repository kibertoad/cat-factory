import type { AgentConfigDescriptor, AgentKind } from '@cat-factory/kernel'
import { registeredConfigContributions } from './registry.js'

// Built-in agent config contributions. An agent kind declares the task-level
// parameters it cares about here; the union over a pipeline's kinds is what the
// task-creation form and inspector render (and freeze once the owning step runs).
// Custom kinds contribute the same way via `registerAgentKind({ configContributions })`.

/** The Tester's environment choice: stand infra up locally, or use the ephemeral env. */
export const TESTER_ENVIRONMENT_CONFIG_ID = 'tester.environment'
/** The acceptance/e2e execution target: project CI, or the ephemeral env. */
export const PLAYWRIGHT_E2E_TARGET_CONFIG_ID = 'playwright.e2eTarget'

const BUILTIN_CONFIG_CONTRIBUTIONS: Partial<Record<AgentKind, AgentConfigDescriptor[]>> = {
  tester: [
    {
      id: TESTER_ENVIRONMENT_CONFIG_ID,
      agentKind: 'tester',
      label: 'Test environment',
      description:
        "Where the Tester runs the suite: with the service's dependencies stood up locally via docker-compose, or against the provisioned ephemeral environment.",
      type: 'select',
      options: [
        { value: 'ephemeral', label: 'Ephemeral environment' },
        { value: 'local', label: 'Local (docker-compose infra)' },
      ],
      // Ephemeral is the zero-config default; local is an opt-in that requires the
      // service's test infra to be configured (a compose path or the no-infra flag).
      default: 'ephemeral',
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
export function configContributionsFor(kind: AgentKind): AgentConfigDescriptor[] {
  const builtin = BUILTIN_CONFIG_CONTRIBUTIONS[kind] ?? []
  const registered = registeredConfigContributions(kind)
  return registered.length ? [...builtin, ...registered] : builtin
}

/**
 * The deduplicated catalog of config descriptors contributed across a set of agent
 * kinds (e.g. all the kinds used by a workspace's pipelines), keyed by descriptor
 * id (first contribution wins). This is what the workspace snapshot carries.
 */
export function configContributionCatalog(kinds: Iterable<AgentKind>): AgentConfigDescriptor[] {
  const byId = new Map<string, AgentConfigDescriptor>()
  for (const kind of kinds) {
    for (const descriptor of configContributionsFor(kind)) {
      if (!byId.has(descriptor.id)) byId.set(descriptor.id, descriptor)
    }
  }
  return [...byId.values()]
}
