// Fixtures for the SDK connection-failure vocabulary guard.
//
// The assertions that matter here are the NEGATIVE ones: a guard that passes on the real tree
// proves nothing until it is shown to go red on the drift it exists to catch, in both directions
// and for each of the four languages' own spelling.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAUSE_SOURCES,
  compareCauseVocabularies,
  readCanonicalCauses,
  readGoCauses,
  readJavaCauses,
  readPythonCauses,
  readTypescriptCauses,
} from './sdk-connection-causes.mjs'

const CANONICAL = `
export const connectionFailureCauseSchema = v.picklist([
  'refused',
  // A comment naming 'a-quoted-thing' inside the block must not become a member.
  'timeout',
  'unknown',
])
`

const TYPESCRIPT = `
export type TransportFailureCause =
  | 'refused'
  | 'timeout'
  | 'unknown'

/** Next declaration. */
`

const PYTHON = `
CAUSES = (
    "refused",
    "timeout",
    "unknown",
)
`

const GO = `
const (
\tcauseRefused failureCause = "refused"
\tcauseTimeout failureCause = "timeout"
\tcauseUnknown failureCause = "unknown"
)
`

const JAVA = `
    enum Cause {
        REFUSED,
        TIMEOUT,
        UNKNOWN
    }
`

/** A reader over a fixture bag, so a case can perturb exactly one source. */
function readerFor(overrides = {}) {
  const files = {
    [CAUSE_SOURCES.contracts]: CANONICAL,
    [CAUSE_SOURCES.typescript]: TYPESCRIPT,
    [CAUSE_SOURCES.python]: PYTHON,
    [CAUSE_SOURCES.go]: GO,
    [CAUSE_SOURCES.java]: JAVA,
    ...overrides,
  }
  return (path) => files[path]
}

test('each reader extracts its own language’s member list', () => {
  assert.deepEqual(readCanonicalCauses(CANONICAL), ['refused', 'timeout', 'unknown'])
  assert.deepEqual(readTypescriptCauses(TYPESCRIPT), ['refused', 'timeout', 'unknown'])
  assert.deepEqual(readPythonCauses(PYTHON), ['refused', 'timeout', 'unknown'])
  assert.deepEqual(readGoCauses(GO), ['refused', 'timeout', 'unknown'])
  // Java's enum constants are lowered to the wire spelling, hyphen included.
  assert.deepEqual(readJavaCauses('enum Cause { TLS_UNTRUSTED, UNKNOWN }'), [
    'tls-untrusted',
    'unknown',
  ])
})

test('agreeing vocabularies report nothing', () => {
  assert.deepEqual(compareCauseVocabularies(readerFor()), [])
})

test('a member the platform ADDS is reported against every client that lacks it', () => {
  const grown = CANONICAL.replace("'refused',", "'refused',\n  'quic-refused',")
  const problems = compareCauseVocabularies(readerFor({ [CAUSE_SOURCES.contracts]: grown }))
  assert.equal(problems.length, 4)
  for (const sdk of ['typescript', 'python', 'go', 'java']) {
    assert.ok(
      problems.some((problem) => problem.startsWith(`${sdk} `) && problem.includes('quic-refused')),
      `expected ${sdk} to be named as unable to produce the added member`,
    )
  }
})

test('a member a client keeps after the platform RETIRES it is reported as extra', () => {
  const shrunk = CANONICAL.replace("  'timeout',\n", '')
  const problems = compareCauseVocabularies(readerFor({ [CAUSE_SOURCES.contracts]: shrunk }))
  assert.equal(problems.length, 4)
  assert.ok(problems.every((problem) => problem.includes('no longer has')))
})

test('one client drifting names that client alone', () => {
  const problems = compareCauseVocabularies(
    readerFor({ [CAUSE_SOURCES.java]: 'enum Cause { REFUSED, UNKNOWN }' }),
  )
  assert.deepEqual(problems.length, 1)
  assert.ok(problems[0].startsWith('java '))
  assert.ok(problems[0].includes('timeout'))
})

test('a source the guard can no longer parse FAILS rather than passing', () => {
  // The regression this pins: renaming a declaration must not turn the guard off silently.
  const problems = compareCauseVocabularies(
    readerFor({ [CAUSE_SOURCES.python]: 'TRANSPORT_CAUSES = ("refused",)' }),
  )
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('could not read the ported vocabulary'))
})

test('an unreadable CANONICAL source fails loudly and stops', () => {
  const problems = compareCauseVocabularies(
    readerFor({ [CAUSE_SOURCES.contracts]: 'export const somethingElse = v.picklist([])' }),
  )
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('could not read the canonical vocabulary'))
})
