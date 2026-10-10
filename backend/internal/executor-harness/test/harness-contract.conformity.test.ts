import { HARNESS_JOB_PORT } from '@cat-factory/contracts'
import {
  HARNESS_SENTINEL_PATHS,
  checkoutDirDigest as backendCheckoutDirDigest,
  safeDirSegment as backendSafeDirSegment,
  siblingCheckoutDir as backendSiblingCheckoutDir,
} from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { checkoutDirDigest, makeDirClaimer, safeDirSegment } from '../src/checkout-dir.js'
import { EFFORT_REPORT_FILE } from '../src/effort.js'
import { FOLLOW_UPS_FILENAME } from '../src/follow-ups.js'
import { CONTEXT_DIR } from '../src/pi.js'
import { PR_DESCRIPTION_FILE } from '../src/pr-description.js'
import { REFERENCE_SCREENSHOT_DIR } from '../src/reference-screenshots.js'
import { DESIGN_RENDER_DIR } from '../src/design-images.js'
import { GENERATED_BINARY_DIR } from '../src/codex-images.js'
import { DEFAULT_HARNESS_PORT } from '../src/harness-port.js'

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

  // The whole directory name, not just its inputs: a matching sanitiser joined differently would
  // still point the agent at the wrong directory. Compared against the backend's OWN
  // `siblingCheckoutDir` rather than a join recomposed here, so this pins the two PRODUCTION
  // functions to each other instead of pinning both to a third copy of the rule that would go
  // stale without failing.
  it('names the checkout directory identically on both sides', () => {
    const claim = makeDirClaimer()
    for (const owner of SEGMENTS) {
      for (const name of SEGMENTS) {
        expect(claim({ owner, name })).toBe(backendSiblingCheckoutDir(owner, name))
      }
    }
  })

  it('digests the owner/name pair identically on both sides', () => {
    for (const owner of SEGMENTS) {
      for (const name of SEGMENTS) {
        expect(checkoutDirDigest(owner, name)).toBe(backendCheckoutDirDigest(owner, name))
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

  it('keeps `_` out of what the sanitiser manufactures', () => {
    // Not a collision-freedom argument any more (the digest carries that), but still the rule
    // the readable prefix depends on: a replaced character must not turn into the join's own
    // separator, or `owner__name` stops reading as owner-then-name for a human skimming the
    // prompt.
    expect(safeDirSegment('a/b')).not.toContain('_')
    expect(safeDirSegment('a b')).not.toContain('_')
  })

  // The property the digest exists for, asserted on the pairs that actually collide rather than
  // on a restatement of the rule. Each pair below sanitises+joins to ONE prefix, so before the
  // digest both legs of a multi-repo run claimed a single directory and the second one's clone
  // died against a directory the first had already filled.
  //
  // These are GitLab shapes, not hypotheticals: `owner` is a namespace PATH there (`grp/sub`,
  // sanitised to `grp-sub`) and GitLab paths allow `_`, so neither the separator argument nor
  // the sanitiser is injective on its own.
  const COLLIDING_PREFIX_PAIRS: Array<[[string, string], [string, string]]> = [
    // `_` inside a segment makes the `__` join ambiguous.
    [
      ['a__b', 'c'],
      ['a', 'b__c'],
    ],
    // A nested namespace path and a top-level group named for it sanitise alike.
    [
      ['grp/sub', 'api'],
      ['grp-sub', 'api'],
    ],
    // The sanitiser folds distinct character classes onto the same `-`.
    [
      ['acme corp', 'api'],
      ['acme/corp', 'api'],
    ],
  ]

  for (const [[ownerA, nameA], [ownerB, nameB]] of COLLIDING_PREFIX_PAIRS) {
    const label = `${ownerA}/${nameA} vs ${ownerB}/${nameB}`
    it(`separates two repos whose sanitised prefix collides (${label})`, () => {
      const claim = makeDirClaimer()
      const a = claim({ owner: ownerA, name: nameA })
      const b = claim({ owner: ownerB, name: nameB })

      // The premise: without the digest these two ARE the same directory.
      expect(`${backendSafeDirSegment(ownerA)}__${backendSafeDirSegment(nameA)}`).toBe(
        `${backendSafeDirSegment(ownerB)}__${backendSafeDirSegment(nameB)}`,
      )
      expect(a).not.toBe(b)
      // Both sides have to separate them the same way, or the prompt names one of the two.
      expect(a).toBe(backendSiblingCheckoutDir(ownerA, nameA))
      expect(b).toBe(backendSiblingCheckoutDir(ownerB, nameB))
    })
  }

  it('gives every distinct pair in the fixture set its own directory', () => {
    const claim = makeDirClaimer()
    const byDir = new Map<string, string>()
    const collisions: string[] = []
    for (const owner of SEGMENTS) {
      for (const name of SEGMENTS) {
        const dir = claim({ owner, name })
        const previous = byDir.get(dir)
        if (previous !== undefined) collisions.push(`${previous} and ${owner}/${name} → ${dir}`)
        else byDir.set(dir, `${owner}/${name}`)
      }
    }
    expect(collisions).toEqual([])
  })

  it('emits a directory name that is still a single safe path segment', () => {
    // The digest must not reintroduce what the sanitiser exists to remove.
    for (const owner of SEGMENTS) {
      for (const name of SEGMENTS) {
        expect(makeDirClaimer()({ owner, name })).toMatch(/^[A-Za-z0-9._-]+$/)
      }
    }
  })
})

describe('harness ⇄ backend sentinel paths', () => {
  const PAIRS: Array<[name: string, harness: string, backend: string]> = [
    ['effort report', EFFORT_REPORT_FILE, HARNESS_SENTINEL_PATHS.effortReport],
    ['PR description', PR_DESCRIPTION_FILE, HARNESS_SENTINEL_PATHS.prDescription],
    ['context directory', CONTEXT_DIR, HARNESS_SENTINEL_PATHS.contextDir],
    ['follow-ups', FOLLOW_UPS_FILENAME, HARNESS_SENTINEL_PATHS.followUps],
    [
      'reference screenshots directory',
      REFERENCE_SCREENSHOT_DIR,
      HARNESS_SENTINEL_PATHS.referenceScreenshots,
    ],
    ['design renders directory', DESIGN_RENDER_DIR, HARNESS_SENTINEL_PATHS.designRenders],
    [
      'generated binaries directory',
      GENERATED_BINARY_DIR,
      HARNESS_SENTINEL_PATHS.generatedBinaries,
    ],
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

describe('harness ⇄ backend job port', () => {
  it('binds the port every transport dispatches to', () => {
    // The harness CHOOSES the port and every transport ADDRESSES it: the Cloudflare container
    // class's `defaultPort`, the local runtime's `-p 127.0.0.1:0:<port>` publish, and a runner
    // pool's pod-proxy URL all read the contract's copy. Drift is a total outage of container
    // dispatch (nothing answers), so the two literals are pinned rather than commented.
    expect(DEFAULT_HARNESS_PORT).toBe(HARNESS_JOB_PORT)
  })

  it('stays out of the range a service under test would pick', () => {
    // The defect this replaced: on 8080 the harness held the port a containerised service
    // defaults to AND answered its health check, so a tester could grade the platform green in
    // place of the product. Unprivileged, clear of the habitual low ports, and below the
    // ephemeral floor an outbound connection could already be holding.
    expect(DEFAULT_HARNESS_PORT).toBeGreaterThan(1023)
    expect(DEFAULT_HARNESS_PORT).toBeLessThan(32768)
    expect([3000, 4173, 5000, 5173, 8000, 8080, 8081, 8443, 8888, 9000]).not.toContain(
      DEFAULT_HARNESS_PORT,
    )
  })
})
