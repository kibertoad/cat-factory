import {
  HARNESS_SENTINEL_PATHS,
  safeDirSegment as backendSafeDirSegment,
} from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { makeDirClaimer, safeDirSegment } from '../src/coding-agent.js'
import { EFFORT_REPORT_FILE } from '../src/effort.js'
import { FOLLOW_UPS_FILENAME } from '../src/follow-ups.js'
import { CONTEXT_DIR } from '../src/pi.js'
import { PR_DESCRIPTION_FILE } from '../src/pr-description.js'

// The harness image builds from `src/` plus typescript alone, so it can carry no runtime
// dependency on a workspace package: every path both halves must agree about is computed
// INDEPENDENTLY here and in `@cat-factory/server`'s `agents/harnessContract.ts`. Comments on both
// sides have claimed byte-identity for a while with nothing enforcing it; this suite is the
// enforcement, in the style of `host-markdown.conformity.test.ts`.
//
// Drift here is silent in the worst way. The harness CREATES the sibling checkout directory and
// the backend NAMES it in the agent's prompt, so a divergent sanitiser points the agent at a
// directory that does not exist, and on a multi-repo run at a directory belonging to a DIFFERENT
// repository. The four sentinel paths are the same shape of bug: the harness materialises,
// tails or removes a file the prompt told the agent to read or write, so a divergent name reads
// to the agent exactly like a platform that provided nothing.
//
// This is a `test/**`-only file, so it ships with NO runner-image bump.

// Owner/name inputs chosen for what the sanitiser actually has to decide: the pass-through case,
// each class of replaced character, the empty-after-replacement fallback, and the `_` the
// `owner__name` join reserves as its separator.
const SEGMENTS = [
  'acme',
  'cat-factory',
  'dot.name',
  'under_score',
  'Mixed-Case_1.2',
  'slash/inside',
  'space inside',
  'unicode-Ω-payload',
  'punctuation!@#$%^&*()',
  '../traversal',
  '...',
  '///',
  '!!!',
  '',
  '-',
  '_',
  '.',
]

describe('harness ⇄ backend checkout-directory contract', () => {
  for (const segment of SEGMENTS) {
    it(`sanitises ${JSON.stringify(segment)} identically on both sides`, () => {
      expect(safeDirSegment(segment)).toBe(backendSafeDirSegment(segment))
    })
  }

  // The join, not just its inputs: the backend composes `owner__name` in `siblingCheckoutDir` and
  // the harness in `makeDirClaimer`, so a matching sanitiser with a different separator would
  // still point the agent at the wrong directory.
  it('joins owner and name identically on both sides', () => {
    const claim = makeDirClaimer()
    for (const owner of SEGMENTS) {
      for (const name of SEGMENTS) {
        expect(claim({ owner, name })).toBe(
          `${backendSafeDirSegment(owner)}__${backendSafeDirSegment(name)}`,
        )
      }
    }
  })

  // The properties the pair exists for, asserted directly so a conforming-but-wrong pair (both
  // drifting together) still fails.
  it('never emits a path separator or an empty segment', () => {
    for (const segment of SEGMENTS) {
      const out = safeDirSegment(segment)
      expect(out).not.toBe('')
      expect(out).not.toContain('/')
      expect(out).not.toContain('\\')
      expect(out).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })

  it('keeps `_` available as the join separator', () => {
    // GitHub owners contain no `_`, which is what makes `owner__name` collision-free. The
    // sanitiser must not manufacture one out of a replaced character, or two distinct repos
    // could claim one directory.
    expect(safeDirSegment('a/b')).not.toContain('_')
    expect(safeDirSegment('a b')).not.toContain('_')
  })
})

describe('harness ⇄ backend sentinel paths', () => {
  const PAIRS: Array<[name: string, harness: string, backend: string]> = [
    ['effort report', EFFORT_REPORT_FILE, HARNESS_SENTINEL_PATHS.effortReport],
    ['PR description', PR_DESCRIPTION_FILE, HARNESS_SENTINEL_PATHS.prDescription],
    ['context directory', CONTEXT_DIR, HARNESS_SENTINEL_PATHS.contextDir],
    ['follow-ups', FOLLOW_UPS_FILENAME, HARNESS_SENTINEL_PATHS.followUps],
  ]

  for (const [name, harness, backend] of PAIRS) {
    it(`agrees on the ${name} path`, () => {
      expect(harness).toBe(backend)
    })
  }

  it('covers every sentinel the backend declares', () => {
    // Derived from the backend's own record rather than a pinned count, so ADDING a sentinel
    // fails here until it is paired, and neither side can quietly grow an unpinned path.
    expect(PAIRS.map(([, , backend]) => backend).sort()).toEqual(
      Object.values(HARNESS_SENTINEL_PATHS).slice().sort(),
    )
  })
})
