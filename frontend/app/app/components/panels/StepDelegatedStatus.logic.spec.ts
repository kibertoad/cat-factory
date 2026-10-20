import { describe, it, expect } from 'vitest'
import {
  DELEGATION_STATUS_KEY,
  DELEGATION_STATUS_META,
  KNOWN_DELEGATION_STATUSES,
  UNKNOWN_DELEGATION_STATUS_META,
  delegatedUsageUnreported,
  delegationStatusView,
  externalRunHref,
} from './StepDelegatedStatus.logic'
import type { RunDelegationStatus } from '~/types/execution'

/**
 * The status of external work is a CLOSED, PERSISTED vocabulary, which is the pairing that makes an
 * exhaustive `Record` over it total against the TYPE and partial against the DATA. These pin the
 * two ways that regresses: a member with no presentation, and a stored value this build does not
 * know taking the whole panel down with it.
 */
describe('delegation status presentation', () => {
  it('gives every status in the wire vocabulary its own row in both maps', () => {
    // Derived from the schema the backend decides against, not from a list retyped here.
    expect(Object.keys(DELEGATION_STATUS_META).sort()).toEqual(
      [...KNOWN_DELEGATION_STATUSES].sort(),
    )
    expect(Object.keys(DELEGATION_STATUS_KEY).sort()).toEqual([...KNOWN_DELEGATION_STATUSES].sort())
  })

  it('never points two statuses at one label', () => {
    const keys = Object.values(DELEGATION_STATUS_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('resolves a known status to its own row', () => {
    const view = delegationStatusView('running')
    expect(view.status).toBe('running')
    expect(view.meta).toEqual(DELEGATION_STATUS_META.running)
    expect(view.labelKey).toBe(DELEGATION_STATUS_KEY.running)
  })

  it('renders a status this build does not know as unrecognised, NAMING the raw value', () => {
    // The panel is the only place a person can read what happened to work the platform cannot see,
    // so a bare `Record` lookup here is `undefined.cls` thrown during render: a white screen over
    // the answer. Guessing onto a current member is the other wrong answer, because nothing can
    // know which one was meant and the wrong guess reports the wrong outcome for a live run.
    const view = delegationStatusView('quiesced')
    expect(view.status).toBeNull()
    expect(view.meta).toEqual(UNKNOWN_DELEGATION_STATUS_META)
    expect(view.labelKey).toBe('panels.stepMeta.delegated.status.unrecognised')
    expect(view.labelParams).toEqual({ status: 'quiesced' })
  })

  it('does not mistake an inherited object member for a status', () => {
    // `DELEGATION_STATUS_META` is an ordinary object literal, so a persisted value naming
    // `constructor` or `toString` reads back as a truthy non-key on a plain truthiness check.
    for (const value of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(delegationStatusView(value).status).toBeNull()
    }
  })

  it('treats an absent status as unrecognised rather than throwing', () => {
    expect(delegationStatusView(undefined).status).toBeNull()
  })
})

describe('externalRunHref', () => {
  it('links an ordinary run url', () => {
    expect(externalRunHref('https://github.com/acme/widgets/actions/runs/99')).toBe(
      'https://github.com/acme/widgets/actions/runs/99',
    )
    // http too: a deployment's own internal CI is reachable, and this is a link a person clicks,
    // not a request the platform makes.
    expect(externalRunHref('http://ci.internal/jobs/12')).toBe('http://ci.internal/jobs/12')
  })

  it('refuses a scheme that would EXECUTE in this origin', () => {
    // The value comes from an external system's API and lands in the card's primary affordance.
    // Bound straight into `href`, these run as script in the SPA's own origin when clicked.
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>']) {
      expect(externalRunHref(url)).toBeNull()
    }
  })

  it('refuses what it cannot parse, and says nothing about a record with no url', () => {
    expect(externalRunHref('/relative/path')).toBeNull()
    expect(externalRunHref('')).toBeNull()
    expect(externalRunHref(null)).toBeNull()
    expect(externalRunHref(undefined)).toBeNull()
  })
})

describe('delegatedUsageUnreported', () => {
  // The two surfaces answering this question have to agree: the backend's reporting-gap fold
  // counts the same settled steps into `delegatedStepsWithoutUsage`, and a card keyed on the
  // executor's DECLARATION disagreed with it in both directions at once.
  const step = (
    status: RunDelegationStatus,
    metrics?: { calls: number },
  ): Parameters<typeof delegatedUsageUnreported>[0] =>
    ({
      delegated: {
        executor: 'acme:executor',
        status,
        correlationKey: 'k',
        poll: null,
        attempts: [{ startedAt: 0 }],
      },
      ...(metrics ? { metrics } : {}),
    }) as Parameters<typeof delegatedUsageUnreported>[0]

  it('warns on a SETTLED step that reported nothing, whatever the executor declared', () => {
    expect(delegatedUsageUnreported(step('done'), { telemetry: 'self-reported' })).toBe(true)
    expect(delegatedUsageUnreported(step('failed'), { telemetry: 'not-reported' })).toBe(true)
  })

  it('stays silent beside a real number, even from an executor that declared none', () => {
    expect(
      delegatedUsageUnreported(step('done', { calls: 4 }), { telemetry: 'not-reported' }),
    ).toBe(false)
  })

  it('warns while work is IN FLIGHT only where the declaration says none is coming', () => {
    // A `self-reported` executor files with its result, so it has correctly reported nothing yet
    // and the card must not claim a permanent gap while a person watches the step.
    expect(delegatedUsageUnreported(step('running'), { telemetry: 'self-reported' })).toBe(false)
    expect(delegatedUsageUnreported(step('running'), { telemetry: 'not-reported' })).toBe(true)
    // An executor this build no longer registers: nothing here can say otherwise.
    expect(delegatedUsageUnreported(step('starting'), undefined)).toBe(true)
  })

  it('says nothing at all about a step that dispatched nowhere external', () => {
    expect(
      delegatedUsageUnreported({} as Parameters<typeof delegatedUsageUnreported>[0], undefined),
    ).toBe(false)
  })
})
