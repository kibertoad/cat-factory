import { describe, expect, it } from 'vitest'
import {
  describeWildcardDnsShift,
  describeWildcardDnsShiftProblem,
  wildcardDnsShiftRemedies,
  wildcardDnsSuffix,
  wildcardDnsWindows,
} from './wildcard-dns.js'

// Every hostname below was resolved for real while writing this rule, and the expected address is
// what the lookup ANSWERED rather than what the parser here computes. That is the only way this
// file is worth anything: the rule exists to predict a third party's resolver, so a fixture
// derived from our own implementation would agree with it by construction and prove nothing.
//
// Recorded 2026-08-25 against nip.io and sslip.io. If one of them changes how it scans a name,
// this table is where that shows up, and the refusals built on it have to be revisited rather
// than the table quietly re-pinned.
const LOOKUPS: readonly { host: string; answers: string }[] = [
  // The failure this whole module exists for: an acceptance namespace of `cf-acc-5` in front of
  // the documented loopback host, which sent a run's tester at 5.127.0.0 for eight minutes.
  { host: 'cf-acc-5.127.0.0.1.nip.io', answers: '5.127.0.0' },
  { host: 'cf-acc-1.127.0.0.1.nip.io', answers: '1.127.0.0' },
  // The control, one label different, which is what confirmed the namespace was the trigger.
  { host: 'app.127.0.0.1.nip.io', answers: '127.0.0.1' },
  // A two-digit window shifts just as happily as a one-digit one.
  { host: 'foo-12.127.0.0.1.nip.io', answers: '12.127.0.0' },
  { host: 'foo-0.127.0.0.1.nip.io', answers: '0.127.0.0' },
  // A dot before the digits is no safer than a dash: both are separators to these resolvers.
  { host: 'foo.bar-7.127.0.0.1.nip.io', answers: '7.127.0.0' },
  // Not octets, so they open no window: above 255, and a leading zero.
  { host: 'foo-999.127.0.0.1.nip.io', answers: '127.0.0.1' },
  { host: 'cf-acc-05.127.0.0.1.nip.io', answers: '127.0.0.1' },
  // A letter between the prefix and the digits ends the label, which is the cheapest fix.
  { host: 'cf-acc-pr5.127.0.0.1.nip.io', answers: '127.0.0.1' },
  { host: 'cf-acc5.127.0.0.1.nip.io', answers: '127.0.0.1' },
  { host: 'cf-acc-5x.127.0.0.1.nip.io', answers: '127.0.0.1' },
  // Dashes in the address defeat the prefix, because a run may not mix separators.
  { host: 'cf-acc-5.127-0-0-1.nip.io', answers: '127.0.0.1' },
  // Leftmost wins, whichever separator it used and however many windows follow.
  { host: '10-0-0-1.foo.127.0.0.1.nip.io', answers: '10.0.0.1' },
  { host: 'a-1.2.3.4.5.6.7.8.nip.io', answers: '1.2.3.4' },
  { host: 'foo-1.2.3.4.nip.io', answers: '1.2.3.4' },
  { host: 'x-1-2-3-4.nip.io', answers: '1.2.3.4' },
  // sslip.io reads a name the same way, which is why it is on the suffix list.
  { host: 'foo-1.127.0.0.1.sslip.io', answers: '1.127.0.0' },
]

describe('wildcardDnsWindows', () => {
  it.each(LOOKUPS)('answers $answers for $host, as the live lookup did', ({ host, answers }) => {
    // The resolver takes the leftmost window, so that is the whole prediction.
    expect(wildcardDnsWindows(host)[0]).toBe(answers)
  })

  it('finds nothing in a name carrying no address', () => {
    expect(wildcardDnsWindows('app.nip.io')).toEqual([])
  })

  it('reads overlapping windows, because the resolver does', () => {
    expect(wildcardDnsWindows('a-1.2.3.4.5.nip.io')).toEqual(['1.2.3.4', '2.3.4.5'])
  })

  it('does not read an address out of the suffix itself', () => {
    expect(wildcardDnsWindows('1.2.3.4.nip.io')).toEqual(['1.2.3.4'])
  })
})

describe('wildcardDnsSuffix', () => {
  it.each(['a.127.0.0.1.nip.io', 'a.127.0.0.1.sslip.io'])('recognises %s', (host) => {
    expect(wildcardDnsSuffix(host)).not.toBeNull()
  })

  it.each([
    // An ordinary host is none of this rule's business, however many digits it carries.
    'env-5.preview.example.com',
    // A lookalike is not the same resolver, so refusing on its behalf would be a guess.
    'a.127.0.0.1.nip.io.example.com',
    'a.127.0.0.1.notnip.io',
  ])('leaves %s alone', (host) => {
    expect(wildcardDnsSuffix(host)).toBeNull()
    expect(describeWildcardDnsShift(host)).toBeNull()
  })

  it('tolerates a fully-qualified trailing dot and any casing', () => {
    expect(wildcardDnsSuffix('APP.127.0.0.1.NIP.IO.')).toBe('nip.io')
  })
})

describe('describeWildcardDnsShift', () => {
  it('reports the failure that produced this module', () => {
    const shift = describeWildcardDnsShift('cf-acc-5.127.0.0.1.nip.io')
    expect(shift).toEqual({
      host: 'cf-acc-5.127.0.0.1.nip.io',
      suffix: 'nip.io',
      resolved: '5.127.0.0',
      trailing: '127.0.0.1',
    })
  })

  it.each(
    LOOKUPS.filter(({ host, answers }) => {
      const windows = wildcardDnsWindows(host)
      return windows.length > 1 && windows[windows.length - 1] !== answers
    }),
  )('flags $host, which answers $answers', ({ host, answers }) => {
    expect(describeWildcardDnsShift(host)?.resolved).toBe(answers)
  })

  it('stays silent when the only window IS the trailing one', () => {
    // The overwhelmingly common healthy case, and the one a false positive would break: every
    // correctly-configured ephemeral environment on a local cluster looks exactly like this.
    expect(describeWildcardDnsShift('cf-env-catalog-api-pr5.127.0.0.1.nip.io')).toBeNull()
  })

  it('stays silent when a name carries no address at all', () => {
    // Unresolvable, but not MIS-resolvable, and this rule may only speak to the second. Refusing
    // here would put this module in front of a failure it cannot diagnose.
    expect(describeWildcardDnsShift('app.nip.io')).toBeNull()
  })

  it('stays silent when overlapping windows agree', () => {
    expect(describeWildcardDnsShift('a-1.1.1.1.1.nip.io')).toBeNull()
  })
})

describe('describeWildcardDnsShiftProblem', () => {
  const shift = describeWildcardDnsShift('cf-acc-5.127.0.0.1.nip.io')

  it('names both addresses, since neither alone explains the failure', () => {
    const problem = describeWildcardDnsShiftProblem(shift!)
    expect(problem).toContain('cf-acc-5.127.0.0.1.nip.io')
    expect(problem).toContain('5.127.0.0')
    expect(problem).toContain('127.0.0.1')
  })
})

describe('wildcardDnsShiftRemedies', () => {
  const remediesFor = (host: string) => wildcardDnsShiftRemedies(describeWildcardDnsShift(host)!)

  it('keeps the digits, which are doing necessary work', () => {
    // A namespace has to stay unique per environment, so a remedy that just deleted the pull
    // number would trade a wrong address for a collision.
    expect(remediesFor('cf-acc-5.127.0.0.1.nip.io')[0]).toContain('{{pullNumber}}')
  })

  it('offers the dashed address as written, not as a description of one', () => {
    expect(remediesFor('cf-acc-5.127.0.0.1.nip.io')[1]).toContain('127-0-0-1.nip.io')
  })

  it('flips the address to dots when the operator already wrote it with dashes', () => {
    // The remedy used to say "write the address with dashes" whatever the host looked like, which
    // for this one is a description of what the operator already did. A prefix extends a dashed
    // run exactly as it extends a dotted one; only mixing the two separators breaks the window.
    const remedies = remediesFor('cf-env-app-5-127-0-0-1.nip.io')
    expect(remedies[1]).toContain("'127.0.0.1.nip.io' rather than '127-0-0-1.nip.io'")
  })

  it('offers no respelling at all when respelling would not help', () => {
    // A prefix carrying a COMPLETE address of its own answers first no matter what separates it
    // from the tail, so both of the cheap fixes are off the table and saying so is the honest
    // answer. Verified by re-grading the candidate rather than by guessing from the shape.
    const remedies = remediesFor('10-0-0-1.foo.127.0.0.1.nip.io')
    expect(remedies.some((remedy) => remedy.includes('other separator'))).toBe(false)
    expect(remedies[0]).toContain('10.0.0.1')
  })

  it('drops the end-with-a-letter fix when the prefix is a whole address', () => {
    // Telling someone to end `10-0-0-1` with a letter would not remove the address it spells.
    expect(remediesFor('10-0-0-1.foo.127.0.0.1.nip.io')[0]).not.toContain('{{pullNumber}}')
  })

  it('always ends on the fix that works whatever the name looks like', () => {
    for (const host of ['cf-acc-5.127.0.0.1.nip.io', '10-0-0-1.foo.127.0.0.1.nip.io']) {
      expect(remediesFor(host).at(-1)).toContain('a host you control')
    }
  })
})
