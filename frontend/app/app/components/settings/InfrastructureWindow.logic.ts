import type { InfrastructureTab } from '~/types/providerConnections'

// Pure tab arithmetic behind `InfrastructureWindow.vue`: which tabs exist for this deployment,
// and which one to show. Extracted so it is unit-tested directly rather than through the DOM —
// the window's tabs come from THREE probes that resolve independently (the infrastructure
// capability, the provider-connection store, the package-registries module), so the interesting
// behaviour is what happens while the list is still growing, which a rendered-component test
// reproduces only by accident.
//
// Labels stay in the component: a label resolved here would have to travel as a message KEY and
// be fed to `t()` as a variable, which is exactly what defeats the typed-message-key check. The
// component maps a tab onto a literal `t()` call through an exhaustive Record instead.

/** Which of the window's tabs this deployment can show, as their probes currently read. */
export interface InfrastructureTabAvailability {
  /** An execution backend is reported (runner pool / container runtime / local). */
  agents: boolean
  /** A test-environment backend is reported. Also gates the shared-stacks tab. */
  environments: boolean
  /** The package-registries module answered its probe affirmatively (it 503s unconfigured). */
  packageRegistries: boolean
  /**
   * The capability-credential surface has something to show: its probe resolved (the module 503s
   * with no encryption key, and 403s for a caller without `secrets.manage`) AND this deployment's
   * registered capabilities declare a credential, or the workspace stored one nothing declares,
   * or the declaration read failed.
   *
   * Unlike every other tab this one gates on CONTENT as well as availability, because the panel
   * is a CHECKLIST projected from the deployment's code: a build that registers no tool server
   * and no generative integration has no credential to type, so the tab would be a dead end. The
   * failed-read case is deliberately kept IN — an unreadable list and an empty one are the same
   * list and opposite facts, and only the panel can say which one this is.
   */
  capabilityCredentials: boolean
}

/**
 * The window's tabs, in display order. Order is the reading order of the questions they answer:
 * where agent containers run, where test environments run, what those environments attach to,
 * what a checkout may install from, and what the tools an agent reaches authenticate as.
 *
 * Shared stacks ride the test-environment probe because a stack is infra an environment attaches
 * to — there is nothing to attach without an environment backend.
 */
export function infrastructureTabs(available: InfrastructureTabAvailability): InfrastructureTab[] {
  const tabs: InfrastructureTab[] = []
  if (available.agents) tabs.push('runner-pool')
  if (available.environments) tabs.push('environment', 'shared-stacks')
  if (available.packageRegistries) tabs.push('package-registries')
  if (available.capabilityCredentials) tabs.push('capability-credentials')
  return tabs
}

/**
 * The tab to show when the window OPENS. The deep-linked request wins whenever it is available;
 * otherwise fall back to the first tab that is.
 *
 * Whatever tab was showing last time is deliberately NOT consulted: the caller has just asked
 * for `requested`, and honouring a leftover selection over it would silently ignore the deep
 * link. Falling back to `requested` when nothing is available at all keeps the ref naming the
 * thing that was asked for, so the re-pin below can land on it once its probe resolves.
 */
export function openInfrastructureTab(
  tabs: readonly InfrastructureTab[],
  requested: InfrastructureTab,
): InfrastructureTab {
  if (tabs.includes(requested)) return requested
  return tabs[0] ?? requested
}

/**
 * The tab to show after the tab list CHANGES (a probe resolved). Unlike the open-time choice
 * this one protects the user's current position: a tab list that grows under someone reading a
 * tab must not yank them elsewhere.
 *
 * `settled` is what stops the transient single-tab list from stealing the selection. The probes
 * resolve independently, so the list legitimately passes through states missing tabs that are
 * about to appear; falling back to the first tab before the probes have settled would pin the
 * user to whichever one happened to resolve first, and the deep-linked tab would then be
 * REJECTED for being the current one's peer rather than shown.
 */
export function repinInfrastructureTab(
  tabs: readonly InfrastructureTab[],
  current: InfrastructureTab,
  requested: InfrastructureTab,
  settled: boolean,
): InfrastructureTab {
  if (tabs.includes(current)) return current
  if (tabs.includes(requested)) return requested
  if (settled && tabs.length) return tabs[0]!
  return current
}
