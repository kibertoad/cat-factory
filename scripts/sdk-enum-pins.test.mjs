// Fixtures for the SDK emitter's enum ORDER pin.
//
// A released client's member order is a published property: Java emits the vocabulary as an enum
// whose `ordinal()` an integration may have persisted, and three more clients expose a `*_VALUES`
// array in the same sequence. `INLINE_ENUM_NAMES` may therefore fix the order as well as the name.
//
// The pin's own correctness is the one thing nothing downstream can catch. `pnpm check:sdk`
// regenerates and diffs, so it catches a change in what is EMITTED — but a wrong pin is consistent
// in both halves of that comparison: the members it names are what the emitter writes and what the
// check re-derives. The failure then arrives twice over and silently, as an SDK enum missing a
// value the API really sends, and as a type registered under a signature nothing looks it up by, so
// the next vocabulary carrying the real set mints a second, positionally-named type beside it.
//
// So the assertions that matter here are the negative ones: a pin that does not describe the
// vocabulary it pins is refused at generation time.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinnedEnumMembers } from './sdk/ir.mjs'

const SEVERITY = ['high', 'low', 'medium']

test('an order pin is used verbatim when it describes the same vocabulary', () => {
  assert.deepEqual(
    pinnedEnumMembers({ name: 'Severity', values: ['low', 'medium', 'high'] }, SEVERITY),
    ['low', 'medium', 'high'],
  )
})

test('an unpinned vocabulary keeps the order the spec declared', () => {
  // A name-only pin and no pin at all are the same answer here: only `{ name, values }` fixes order.
  assert.deepEqual(pinnedEnumMembers('Severity', SEVERITY), SEVERITY)
  assert.deepEqual(pinnedEnumMembers(undefined, SEVERITY), SEVERITY)
})

test('a pin missing a member is refused rather than emitted', () => {
  assert.throws(
    () => pinnedEnumMembers({ name: 'Severity', values: ['low', 'medium'] }, SEVERITY),
    /not a permutation of the vocabulary it pins/,
  )
})

test('a pin that INVENTS a member is refused too', () => {
  // The other direction of the same mistake, and the one a "does the pin cover every value" check
  // would miss: an extra member publishes a constant the API never sends.
  assert.throws(
    () =>
      pinnedEnumMembers(
        { name: 'Severity', values: ['low', 'medium', 'high', 'urgent'] },
        SEVERITY,
      ),
    /not a permutation of the vocabulary it pins/,
  )
})

test('a typo is refused, and the refusal names both sets', () => {
  // The realistic shape of this mistake, and why the message carries both lists: the pin and the
  // vocabulary differ by two characters, which is not something a reader spots from one of them.
  assert.throws(
    () => pinnedEnumMembers({ name: 'Severity', values: ['low', 'medium', 'hgih'] }, SEVERITY),
    (error) =>
      /Severity/.test(error.message) &&
      /hgih/.test(error.message) &&
      /high, low, medium/.test(error.message),
  )
})
