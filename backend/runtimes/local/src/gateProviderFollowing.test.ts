import { describe, expect, it } from 'vitest'
import { createRecordingLogger, defaultProviderRegistry } from '@cat-factory/kernel'
import { CI_STATUS_PROVIDER, MERGEABILITY_PROVIDER } from '@cat-factory/gates'
import {
  VCS_BACKED_GATE_PROVIDERS,
  followVcsReachOnProviderRegistry,
} from './gateProviderFollowing.js'

// A gate probes iff its provider is wired, so this seam decides — for a facade whose VCS client is
// ALWAYS built — whether the CI gate checks anything at all. Both directions are silent failures:
// clearing a provider a deployment can actually use advances PRs as if CI were green, and keeping
// one wired for a deployment that reaches nothing fails every run at a gate documented to pass
// through. Neither is reachable from the container specs (they need Postgres), so it is asserted
// here against a real `ProviderRegistry`.

/** A stand-in for the build's own impls, so "re-wired verbatim" is an identity assertion. */
const builtImpls = () =>
  new Map(VCS_BACKED_GATE_PROVIDERS.map((t) => [t, { token: t.description }]))

function registryWithBuiltProviders() {
  const registry = defaultProviderRegistry()
  const impls = builtImpls()
  for (const [token, impl] of impls) registry.wire(token, impl)
  return { registry, impls }
}

/** Drives the seam with a mutable answer, returning the trigger the facade wires to `onChange`. */
function follow(canReach: () => boolean) {
  const { registry, impls } = registryWithBuiltProviders()
  const listeners: (() => void)[] = []
  const logger = createRecordingLogger()
  followVcsReachOnProviderRegistry({
    registry,
    canReach,
    onChange: (fn) => listeners.push(fn),
    logger,
  })
  return {
    registry,
    impls,
    warnings: () => logger.lines.filter((l) => l.level === 'warn'),
    change: () => listeners.forEach((fn) => fn()),
  }
}

const allWired = (registry: ReturnType<typeof defaultProviderRegistry>) =>
  VCS_BACKED_GATE_PROVIDERS.every((t) => registry.isWired(t))
const noneWired = (registry: ReturnType<typeof defaultProviderRegistry>) =>
  VCS_BACKED_GATE_PROVIDERS.every((t) => !registry.isWired(t))

describe('followVcsReachOnProviderRegistry', () => {
  it('clears every VCS-backed provider while the deployment can reach nothing', () => {
    const { registry, warnings } = follow(() => false)
    expect(noneWired(registry)).toBe(true)
    // The operator has to hear it: the gates are now passing through, not checking.
    expect(warnings().length).toBeGreaterThan(0)
  })

  it('re-wires the BUILD’s own impls, verbatim, when the credential arrives', () => {
    let reachable = false
    const { registry, impls, change } = follow(() => reachable)
    expect(noneWired(registry)).toBe(true)
    reachable = true
    change()
    expect(allWired(registry)).toBe(true)
    // Identity, not merely presence: this seam decides WHETHER a provider is wired, never how.
    for (const [token, impl] of impls) expect(registry.get(token)).toBe(impl)
  })

  it('keeps them wired for a MOTHERSHIP node that holds no credential of its own', () => {
    // Delegation reaches GitHub on installation tokens the mothership mints, and backing
    // gates/merge is one of the things it exists for. Keyed on the credential alone, every
    // mothership run would advance as if CI were green.
    const hasCredential = false
    const hasDelegation = true
    const { registry } = follow(() => hasCredential || hasDelegation)
    expect(allWired(registry)).toBe(true)
    expect(registry.isWired(CI_STATUS_PROVIDER)).toBe(true)
    expect(registry.isWired(MERGEABILITY_PROVIDER)).toBe(true)
  })

  it('warns once per TRANSITION to unwired, not on every re-apply', () => {
    // A re-apply that changes nothing must not reprint the unrelated (release-health,
    // incident-enrichment) advisories `warnUnwiredGates` also carries.
    const { warnings, change } = follow(() => false)
    const first = warnings().length
    change()
    change()
    expect(warnings().length).toBe(first)
  })
})
