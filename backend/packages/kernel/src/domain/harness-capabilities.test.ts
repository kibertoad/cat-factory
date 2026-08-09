import { describe, expect, it } from 'vitest'
import {
  HARNESS_BODY_CAPABILITIES,
  type HarnessBodyCapability,
  describeHarnessBodyCapability,
  harnessCapabilityUnsupportedMessage,
  isHarnessBodyCapability,
  parseHarnessBodyCapabilities,
  readRunnerDispatchAck,
  requiredHarnessCapabilities,
  resolveHarnessCapabilitySupport,
} from './harness-capabilities.js'

// The whole module exists for ONE distinction: an image that reported nothing is not an image
// that reported "not this". Most of what is asserted here is that the two stay apart end to end,
// because collapsing them is the failure mode with two opposite costs: refusing every run on
// every image one version behind, or letting a genuinely blind run through.

describe('the capability vocabulary', () => {
  it('is derived, so the list cannot drift from the union', () => {
    for (const capability of HARNESS_BODY_CAPABILITIES) {
      expect(isHarnessBodyCapability(capability)).toBe(true)
      expect(describeHarnessBodyCapability(capability)).toBeTruthy()
    }
  })

  it('rejects anything not in it', () => {
    expect(isHarnessBodyCapability('contextFiles')).toBe(false)
    expect(isHarnessBodyCapability(undefined)).toBe(false)
  })
})

describe('parseHarnessBodyCapabilities', () => {
  it('tells an absent list apart from an empty one', () => {
    // The load-bearing pair. `undefined` is "no handshake"; `[]` is an image saying it parses
    // none of them, which is a refusal-worthy answer.
    expect(parseHarnessBodyCapabilities(undefined)).toBeUndefined()
    expect(parseHarnessBodyCapabilities('mcpServers')).toBeUndefined()
    expect(parseHarnessBodyCapabilities([])).toEqual([])
  })

  it('drops names this backend does not know rather than carrying them', () => {
    // A NEWER image reporting something we never send is not usable information, and keeping it
    // would put an unbounded string into the metric dimension the report site uses.
    expect(parseHarnessBodyCapabilities(['mcpServers', 'holograms', 7])).toEqual(['mcpServers'])
  })
})

describe('requiredHarnessCapabilities', () => {
  it('reads what the BODY carries, not what a kind declares', () => {
    expect(requiredHarnessCapabilities({ mcpServers: [{ id: 'docs' }] })).toEqual(['mcpServers'])
    // A dispatch that dropped every server for its own reasons promised the agent nothing.
    expect(requiredHarnessCapabilities({ mcpServers: [] })).toEqual([])
    expect(requiredHarnessCapabilities({})).toEqual([])
  })

  it('sees an object-shaped capability, not only the list-shaped ones', () => {
    // The regression this pins: `designImages` is a manifest, not a list, so the populated-list
    // test the other capabilities share read it as absent. The handshake then never fired for it,
    // and an image predating the field ignored the manifest while the prompt named a directory
    // nothing wrote, which is exactly the blind run the handshake exists to refuse.
    expect(
      requiredHarnessCapabilities({
        designImages: { url: 'https://x/y', token: 't', files: [{ artifactId: 'a' }] },
      }),
    ).toEqual(['designImages'])
    // A manifest with no files promises the agent nothing, exactly as an empty server list does.
    expect(
      requiredHarnessCapabilities({ designImages: { url: 'https://x/y', files: [] } }),
    ).toEqual([])
  })

  it('covers every capability, because the name IS the body field', () => {
    // One POPULATED body per capability, typed as an exhaustive `Record` so a new member cannot be
    // added without stating what carrying it looks like. Built from wire shapes rather than from
    // the predicates the code reads, so a predicate loosened to accept anything still fails here.
    const populated: Record<HarnessBodyCapability, unknown> = {
      mcpServers: [{ id: 'docs' }],
      skills: [{ id: 'house-style' }],
      designImages: { url: 'https://x/y', token: 't', files: [{ artifactId: 'a' }] },
    }
    expect(requiredHarnessCapabilities(populated)).toEqual(HARNESS_BODY_CAPABILITIES)
  })
})

describe('resolveHarnessCapabilitySupport', () => {
  it('is supported when the body carried nothing, whatever the harness said', () => {
    expect(resolveHarnessCapabilitySupport([], undefined)).toEqual({ kind: 'supported' })
    expect(resolveHarnessCapabilitySupport([], [])).toEqual({ kind: 'supported' })
  })

  it('is unknown, never unsupported, when no handshake was reported', () => {
    // The false-accusation guard: an image between "the capability landed" and "the handshake
    // landed" serves tool servers perfectly and reports no list.
    expect(resolveHarnessCapabilitySupport(['mcpServers'], undefined)).toEqual({
      kind: 'unknown',
      required: ['mcpServers'],
    })
  })

  it('is unsupported when the harness reported a list without the capability', () => {
    expect(resolveHarnessCapabilitySupport(['mcpServers'], ['skills'])).toEqual({
      kind: 'unsupported',
      missing: ['mcpServers'],
    })
    expect(resolveHarnessCapabilitySupport(['mcpServers', 'skills'], [])).toEqual({
      kind: 'unsupported',
      missing: ['mcpServers', 'skills'],
    })
  })

  it('is supported when every required capability is named', () => {
    expect(resolveHarnessCapabilitySupport(['mcpServers'], ['skills', 'mcpServers'])).toEqual({
      kind: 'supported',
    })
  })
})

describe('readRunnerDispatchAck', () => {
  it('reads a capability list off an acceptance body', () => {
    expect(readRunnerDispatchAck({ jobId: 'j', capabilities: ['mcpServers'] })).toEqual({
      capabilities: ['mcpServers'],
    })
  })

  it('answers undefined for a body carrying no handshake, and never throws', () => {
    // Every one of these is a live dispatch the harness already accepted: the reader must
    // degrade to "could not tell" rather than turn an unreadable body into a failed job.
    expect(readRunnerDispatchAck(undefined)).toBeUndefined()
    expect(readRunnerDispatchAck(null)).toBeUndefined()
    expect(readRunnerDispatchAck('202 Accepted')).toBeUndefined()
    expect(readRunnerDispatchAck({ jobId: 'j', state: 'running' })).toBeUndefined()
    expect(readRunnerDispatchAck({ capabilities: 'mcpServers' })).toBeUndefined()
  })

  it('keeps the wire values verbatim, leaving the narrowing to one place', () => {
    // The transports forward; only `parseHarnessBodyCapabilities` decides what a name means.
    expect(readRunnerDispatchAck({ capabilities: ['whatever', 3] })).toEqual({
      capabilities: ['whatever'],
    })
  })
})

describe('harnessCapabilityUnsupportedMessage', () => {
  it('names the capability and whose fix it is', () => {
    const message = harnessCapabilityUnsupportedMessage(['mcpServers'], 'stopped')
    expect(message).toContain(describeHarnessBodyCapability('mcpServers'))
    expect(message).toContain('runner pool')
  })

  it('says the agent is stopped ONLY when it is', () => {
    // Refusing the step and stopping the container are two achievements, and only a `stopped`
    // outcome is both. Every other one has to send the reader to look, because on those backends
    // a full agent pass really is still running against the repository.
    expect(harnessCapabilityUnsupportedMessage(['skills'], 'stopped')).toContain(
      'nothing is still running',
    )
    for (const stop of ['requested', 'unsupported', 'failed'] as const) {
      const message = harnessCapabilityUnsupportedMessage(['skills'], stop)
      expect(message).not.toContain('nothing is still running')
      // Each still has to say what to DO, or the honesty is just an unactionable caveat.
      expect(message).toMatch(/check the pool|stop it on the runner/)
    }
  })

  it('distinguishes a pool that was asked from a backend that cannot be', () => {
    // Both mean "go and look", but at different things: one deployment has a cancel that may not
    // have worked, the other has no cancel at all and needs one wired.
    expect(harnessCapabilityUnsupportedMessage(['skills'], 'requested')).not.toEqual(
      harnessCapabilityUnsupportedMessage(['skills'], 'unsupported'),
    )
  })
})
