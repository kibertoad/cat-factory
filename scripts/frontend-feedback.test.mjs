// Fixtures for the hand-built feedback-state ban (issue #2252). Run with `node --test scripts/`,
// the built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findFeedbackOffences,
  PENDING,
  SPINNER,
  TOAST_FUNNELS,
} from './check-frontend-feedback.mjs'
import { codeLines } from './lib/frontend-scan.mjs'

const COMPONENT = 'frontend/app/app/components/settings/Example.vue'

/** Every offence in a source fragment, read line by line the way the CLI reads a file. */
const find = (source, rel = COMPONENT) =>
  codeLines(source).flatMap((line) => findFeedbackOffences(rel, line))

describe('toast.add', () => {
  it('flags a direct call, whatever handle it is made through', () => {
    assert.deepEqual(find("toast.add({ title: t('x.saved'), color: 'success' })"), ['toast.add('])
    // A store threads the handle through a context object; the defect is the same.
    assert.deepEqual(find("  ctx.toast.add({ title: tr('x') })"), ['toast.add('])
    assert.deepEqual(find('useToast().add({ title })'), ['toast.add('])
  })

  it('does not match a longer identifier that merely ends in `toast`', () => {
    assert.deepEqual(find('breadtoast.add(slice)'), [])
    assert.deepEqual(find('const toastAdd = vi.fn()'), [])
  })

  it('admits the two funnels, the error funnel directory included', () => {
    for (const funnel of TOAST_FUNNELS) {
      const rel = funnel.endsWith('/') ? `${funnel}bespokeConflicts.ts` : funnel
      assert.deepEqual(find('toast.add({ title })', rel), [], rel)
    }
    // A sibling whose name starts like a funnel's is not one.
    assert.deepEqual(
      find('toast.add({ title })', 'frontend/app/app/composables/useActionToastExtras.ts'),
      ['toast.add('],
    )
  })

  it('ignores a comment about the rule', () => {
    assert.deepEqual(find('// never call toast.add( here'), [])
    assert.deepEqual(find('<!-- toast.add( is banned -->'), [])
  })
})

describe('animate-spin', () => {
  it('flags a hand-spun icon in a class list, a binding and a ui override', () => {
    assert.deepEqual(find('<UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" />'), [
      'animate-spin',
    ])
    assert.deepEqual(find(`:class="busy ? 'animate-spin' : ''"`), ['animate-spin'])
    assert.deepEqual(find(`:ui="{ leadingIcon: 'animate-spin' }"`), ['animate-spin'])
    // A variant prefix still spins the icon by hand.
    assert.deepEqual(find('class="motion-safe:animate-spin"'), ['animate-spin'])
    // A class list assembled in a utility counts too.
    assert.deepEqual(find("iconClass: 'animate-spin text-app-warning-400',"), ['animate-spin'])
  })

  it('does not match a longer utility name', () => {
    assert.deepEqual(find('class="animate-spinner-custom"'), [])
  })

  it('admits the spinner wrapper alone', () => {
    assert.deepEqual(find(`:class="spinning ? 'motion-safe:animate-spin' : ''"`, SPINNER), [])
  })
})

describe('PENDING', () => {
  it('names a reason for every entry', () => {
    for (const [rel, reason] of Object.entries(PENDING)) {
      assert.ok(rel.startsWith('frontend/app/app/'), rel)
      assert.ok(reason.trim().length > 0, rel)
    }
  })
})
