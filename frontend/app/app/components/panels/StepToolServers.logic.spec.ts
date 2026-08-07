import { describe, it, expect } from 'vitest'
import {
  KNOWN_OBSERVED_STATUSES,
  KNOWN_REASONS,
  OBSERVED_STATUS_KEY,
  REASON_KEY,
  REMEDY_KEY,
  observationFor,
  observationIsFault,
  observationText,
  reasonText,
  remedyText,
  unattributedObservations,
} from './StepToolServers.logic'
import type { ObservedToolServer, ToolServerUnavailableReason } from '~/types/toolServers'

/**
 * A dropped tool server is the whole point of this surface: until it existed, a run that quietly
 * went without its issue tracker was stated only in the agent's own prompt and one backend warn
 * line. These pin the two ways that could regress: a reason with no copy, and a reason this build
 * does not know rendering as nothing at all.
 */
describe('tool-server unavailability reasons', () => {
  it('gives every reason in the wire vocabulary its own copy', () => {
    // Derived from the schema the backend decides against, not from a list retyped here: a member
    // added on the backend then fails THIS assertion instead of shipping as a blank chip.
    expect(Object.keys(REASON_KEY).sort()).toEqual([...KNOWN_REASONS].sort())
  })

  it('never points two reasons at one line', () => {
    // Each member names a different fix (a variable to set, a declaration to change, a person to
    // press Connect), so two sharing copy would send an operator to the wrong place.
    const keys = Object.values(REASON_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('renders a retired reason as unknown, naming the raw code', () => {
    // The vocabulary is persisted on a run, so a step recorded under a member since retired reads
    // back with that member. Dropping it would report a withheld tool as one never declared.
    expect(render('legacy_reason')).toEqual([
      {
        key: 'panels.stepDetail.toolServers.reason.unknown',
        params: { reason: 'legacy_reason' },
      },
    ])
  })

  it('takes the same path for a reason that names an Object.prototype member', () => {
    // The mapping is an ordinary object literal, so `REASON_KEY['constructor']` reads back a
    // truthy inherited function. A truthiness check on the lookup would hand THAT to `t` as a
    // translation key, taking the retired-member path away from the one input shape most likely
    // to reach it from a hand-edited or corrupted row.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(render(inherited)).toEqual([
        {
          key: 'panels.stepDetail.toolServers.reason.unknown',
          params: { reason: inherited },
        },
      ])
    }
  })
})

/**
 * The remedy is the half an operator acts on. A diagnosis with no next step is where this surface
 * started: the reason was already stated to the AGENT in its prompt, and stating it to a person
 * changes nothing unless it also names what to change.
 */
describe('tool-server unavailability remedies', () => {
  it('gives every reason in the wire vocabulary a remedy of its own', () => {
    expect(Object.keys(REMEDY_KEY).sort()).toEqual([...KNOWN_REASONS].sort())
  })

  it('never points two reasons at one remedy', () => {
    // The vocabulary exists BECAUSE each member needs a different fix, so two members sharing a
    // remedy line means either the copy is wrong or the split was.
    const keys = Object.values(REMEDY_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never reuses a reason line as a remedy', () => {
    // The two are rendered together. A remedy pointing at the reason's own key would render the
    // diagnosis twice and read as advice.
    const reasons = new Set(Object.values(REASON_KEY))
    for (const key of Object.values(REMEDY_KEY)) expect(reasons.has(key)).toBe(false)
  })

  it('offers no remedy for a retired reason, rather than guessing one', () => {
    // The build knows the code was recorded and not what it meant. Any remedy here would name a
    // surface picked from a member the operator may never have hit, and the reason line already
    // states the raw code, which is the whole of what is known.
    for (const reason of ['legacy_reason', 'constructor', '__proto__']) {
      expect(remedyText(reason as ToolServerUnavailableReason, (key) => key)).toBeNull()
    }
  })
})

/** Every `t` call `reasonText` made, so the assertion is about the key it CHOSE, not the copy. */
function render(reason: string): { key: string; params?: Record<string, unknown> }[] {
  const seen: { key: string; params?: Record<string, unknown> }[] = []
  reasonText(reason as ToolServerUnavailableReason, (key, params) => {
    seen.push({ key, ...(params ? { params } : {}) })
    return key
  })
  return seen
}

/**
 * The OBSERVED half: what the agent's CLI said about the servers the platform wired. Its whole
 * value is a set of distinctions, and each one collapses into "looks fine" if it is lost — so
 * these pin the distinctions rather than the copy.
 */
describe('tool-server startup observations', () => {
  it('gives every observed status but `ready` its own copy', () => {
    // `ready` is deliberately absent: a started server's line depends on its tool count, which is
    // three sentences rather than one key. Everything else is exhaustive against the schema, so a
    // member added on the backend fails here instead of rendering blank.
    expect([...Object.keys(OBSERVED_STATUS_KEY), 'ready'].sort()).toEqual(
      [...KNOWN_OBSERVED_STATUSES].sort(),
    )
    const keys = Object.values(OBSERVED_STATUS_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('says NOTHING when no observation was made', () => {
    // The distinction the whole field rests on. A codex run, an image one version behind and an
    // unmapped runner pool all report nothing, and any placeholder here would read as a verdict
    // about a server that was very likely fine.
    expect(observationFor(undefined, 'slack')).toBeNull()
    expect(observationText(null, (key) => key)).toBeNull()
    expect(observationIsFault(null)).toBe(false)
  })

  it('distinguishes “nobody looked” from “the CLI never loaded it”', () => {
    // Both render as an absent server on the chip if they are conflated, and only the second is
    // evidence of anything. The first must never raise a fault.
    const notLoaded = observationFor([{ id: 'jira', status: 'ready' }], 'slack')
    expect(notLoaded).toEqual({ kind: 'not_loaded' })
    expect(observationText(notLoaded, (key) => key)).toBe(
      'panels.stepDetail.toolServers.observed.notLoaded',
    )
    expect(observationIsFault(notLoaded)).toBe(true)
  })

  it('separates “started with no tools” from “started, tools uncounted”', () => {
    // A server that connected and exposes nothing reaches the agent exactly like one that was
    // never wired, and every other signal about it says healthy — so it gets its own sentence
    // rather than a "0 tools" that reads as a rendering artefact.
    const none = observationFor([{ id: 'slack', status: 'ready', toolCount: 0 }], 'slack')
    const uncounted = observationFor([{ id: 'slack', status: 'ready' }], 'slack')
    const some = observationFor([{ id: 'slack', status: 'ready', toolCount: 3 }], 'slack')
    expect(observationText(none, (key) => key)).toBe(
      'panels.stepDetail.toolServers.observed.readyNoTools',
    )
    expect(observationText(uncounted, (key) => key)).toBe(
      'panels.stepDetail.toolServers.observed.ready',
    )
    expect(observationText(some, (key) => key)).toBe(
      'panels.stepDetail.toolServers.observed.readyTools',
    )
    // None of the three is a fault: the count is a diagnosis for a person to read, not a verdict
    // the surface should paint red.
    for (const observation of [none, uncounted, some]) {
      expect(observationIsFault(observation)).toBe(false)
    }
  })

  it('flags the two states the platform promised a tool it did not get', () => {
    for (const status of ['failed', 'needs_auth'] as const) {
      expect(observationIsFault(observationFor([{ id: 'slack', status }], 'slack'))).toBe(true)
    }
  })

  it('never flags a status this build could not map', () => {
    // `unknown` is a fact about THIS build, not about the server. Painting it as a fault would
    // send an operator to debug a working integration every time a CLI adds a status word.
    // Cast, because the point is a value the TYPE excludes and the DATA carries: the vocabulary
    // is persisted on a run, so a status recorded by a newer harness (or retired since) reads back
    // here as a member this build has no case for.
    const persisted = observationFor(
      [{ id: 'slack', status: 'reticulating' } as unknown as ObservedToolServer],
      'slack',
    )
    expect(persisted).toEqual({ kind: 'loaded', status: 'unknown' })
    expect(observationIsFault(persisted)).toBe(false)
  })

  it('states a report naming servers the dispatch did not wire', () => {
    // Empty on every ordinary run (`--strict-mcp-config`). The only way to reach it is a producer
    // describing some OTHER job, and silently filtering those rows would present that report as
    // this run's clean bill of health.
    const record = {
      agentKind: 'coder',
      wired: [{ id: 'slack', label: 'Slack', transport: 'http' as const }],
      unavailable: [],
      observed: [
        { id: 'slack', status: 'ready' as const },
        { id: 'stranger', status: 'ready' as const },
      ],
    }
    expect(unattributedObservations(record).map((s) => s.id)).toEqual(['stranger'])
    // …and nothing to state when there was no report at all.
    expect(unattributedObservations({ ...record, observed: undefined })).toEqual([])
  })
})
