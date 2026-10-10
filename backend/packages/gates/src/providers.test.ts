import { describe, expect, it } from 'vitest'
import {
  createRecordingLogger,
  defaultProviderRegistry,
  type ProviderRegistry,
  type ProviderToken,
} from '@cat-factory/kernel'
import {
  CI_STATUS_PROVIDER,
  DOC_QUALITY_PROVIDER,
  INCIDENT_ENRICHMENT_PROVIDER,
  MERGEABILITY_PROVIDER,
  PULL_REQUEST_REVIEW_PROVIDER,
  RELEASE_HEALTH_PROVIDER,
  applyGateProviders,
  clearGateProviders,
  warnUnwiredGates,
  wireCiStatusProvider,
  wireDocQualityProvider,
  wireIncidentEnrichment,
  wireMergeabilityProvider,
  wirePullRequestReviewProvider,
  wireReleaseHealthProvider,
  type GateProviderOverrides,
} from './providers.js'

/** Every built-in gate token, paired with the override key that wires it. */
const TOKENS: ReadonlyArray<{ key: keyof GateProviderOverrides; token: ProviderToken<unknown> }> = [
  { key: 'ciStatus', token: CI_STATUS_PROVIDER as ProviderToken<unknown> },
  { key: 'mergeability', token: MERGEABILITY_PROVIDER as ProviderToken<unknown> },
  { key: 'releaseHealth', token: RELEASE_HEALTH_PROVIDER as ProviderToken<unknown> },
  { key: 'incidentEnrichment', token: INCIDENT_ENRICHMENT_PROVIDER as ProviderToken<unknown> },
  { key: 'prReview', token: PULL_REQUEST_REVIEW_PROVIDER as ProviderToken<unknown> },
  { key: 'docQuality', token: DOC_QUALITY_PROVIDER as ProviderToken<unknown> },
]

/** A distinct stand-in per key, so a mis-routed wiring shows up as the WRONG object. */
const fake = (key: string) => ({ marker: key }) as never

const wired = (registry: ProviderRegistry) =>
  TOKENS.filter(({ token }) => registry.isWired(token)).map(({ key }) => key)

describe('the per-provider wire functions', () => {
  it('each wires its OWN token and clears it again with undefined', () => {
    const registry = defaultProviderRegistry()
    const wire = {
      ciStatus: wireCiStatusProvider,
      mergeability: wireMergeabilityProvider,
      releaseHealth: wireReleaseHealthProvider,
      incidentEnrichment: wireIncidentEnrichment,
      prReview: wirePullRequestReviewProvider,
      docQuality: wireDocQualityProvider,
    } as const

    for (const { key, token } of TOKENS) {
      wire[key](registry, fake(key))
      expect(wired(registry), `${key} wires only itself`).toEqual([key])
      expect(registry.get(token)).toEqual({ marker: key })
      wire[key](registry, undefined)
      expect(wired(registry), `${key} clears itself`).toEqual([])
    }
  })
})

describe('applyGateProviders', () => {
  it('wires exactly the keys present, one at a time', () => {
    for (const { key } of TOKENS) {
      const registry = defaultProviderRegistry()
      applyGateProviders(registry, { [key]: fake(key) })
      expect(wired(registry), key).toEqual([key])
    }
  })

  it('wires every key at once, each onto its own token', () => {
    const registry = defaultProviderRegistry()
    const overrides = Object.fromEntries(TOKENS.map(({ key }) => [key, fake(key)]))
    applyGateProviders(registry, overrides)
    for (const { key, token } of TOKENS) {
      expect(registry.get(token), key).toEqual({ marker: key })
    }
  })

  it('OVERRIDES what the build already wired, which is the seam’s whole purpose', () => {
    const registry = defaultProviderRegistry()
    wireCiStatusProvider(registry, fake('from-config'))
    applyGateProviders(registry, { ciStatus: fake('from-test') })
    expect(registry.get(CI_STATUS_PROVIDER)).toEqual({ marker: 'from-test' })
  })

  it('leaves EVERY absent key exactly as the build wired it, for each key in turn', () => {
    // The presence check is per key, so asserting it for one of them leaves the other five free
    // to drop theirs. That failure is not a missing wiring but a CLEARED one: a key absent from
    // the bag reaches `wire(token, undefined)`, which DELETES the entry, so a single-key override
    // from a test or embedder would silently unwire the five providers the facade's config had
    // already supplied and turn those gates into pass-throughs.
    for (const { key: present } of TOKENS) {
      const registry = defaultProviderRegistry()
      applyGateProviders(
        registry,
        Object.fromEntries(TOKENS.map(({ key }) => [key, fake('from-config')])),
      )
      applyGateProviders(registry, { [present]: fake('from-test') })
      expect(wired(registry).sort(), present).toEqual(TOKENS.map(({ key }) => key).sort())
      for (const { key, token } of TOKENS) {
        expect(registry.get(token), `${present} present, ${key} untouched`).toEqual({
          marker: key === present ? 'from-test' : 'from-config',
        })
      }
    }
  })

  it('is a no-op for no overrides and for an empty bag', () => {
    const registry = defaultProviderRegistry()
    wireCiStatusProvider(registry, fake('from-config'))
    applyGateProviders(registry, undefined)
    applyGateProviders(registry, {})
    expect(wired(registry)).toEqual(['ciStatus'])
    expect(registry.get(CI_STATUS_PROVIDER)).toEqual({ marker: 'from-config' })
  })
})

describe('clearGateProviders', () => {
  it('clears every built-in gate provider, and only needs a registry to do it', () => {
    const registry = defaultProviderRegistry()
    applyGateProviders(
      registry,
      Object.fromEntries(TOKENS.map(({ key }) => [key, fake(key)])) as GateProviderOverrides,
    )
    expect(wired(registry)).toHaveLength(TOKENS.length)
    clearGateProviders(registry)
    expect(wired(registry)).toEqual([])
  })

  it('is safe on a registry that has nothing wired', () => {
    const registry = defaultProviderRegistry()
    clearGateProviders(registry)
    expect(wired(registry)).toEqual([])
  })
})

describe('the unwired-gate warning message', () => {
  it('names the gate and the operational effect in the line an operator reads', () => {
    // The structured fields are for machines; the MESSAGE is what appears in the log an
    // operator is scanning, so a gate silently passing through has to be legible there.
    const registry = defaultProviderRegistry()
    const log = createRecordingLogger()
    warnUnwiredGates(registry, log)
    const lines = log.lines.filter((l) => l.level === 'warn')
    // Nothing is wired here, so every pass-through gate must have reported itself; a vacuous
    // loop below would pass over a warning that stopped naming anything.
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.msg).toContain(`gate '${String(line.fields.gate)}'`)
      expect(line.msg).toContain(String(line.fields.effect))
      expect(line.msg).toContain('passing through')
    }
  })
})
