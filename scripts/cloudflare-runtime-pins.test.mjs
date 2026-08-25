// Fixtures for the Cloudflare runtime-pin guard. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard is the only thing standing between this repo and the failure it describes, and that
// failure is silent by construction (two green halves, a runtime difference nobody looks for). So
// its own logic is pinned here: each fixture is one way the split has actually been able to
// arrive, plus the vacuum case a rule-based guard fails open on.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  collectResolvedVersions,
  findPinViolations,
  releaseDateOf,
} from './cloudflare-runtime-pins.mjs'

const LOCKFILE = `lockfileVersion: '9.0'

overrides:
  wrangler: 9.9.9

packages:

  '@cloudflare/vitest-pool-workers@0.22.0':
    resolution: {integrity: sha512-aaa}

  '@cloudflare/workers-types@5.20260815.1':
    resolution: {integrity: sha512-bbb}

  miniflare@5.20260815.0-alpha:
    resolution: {integrity: sha512-ccc}

  workerd@1.20260815.1:
    resolution: {integrity: sha512-ddd}

  wrangler@4.124.0:
    resolution: {integrity: sha512-eee}

snapshots:

  wrangler@4.124.0(@cloudflare/workers-types@5.20260815.1):
    dependencies:
      workerd: 1.20260815.1
`

const cleanManifest = {
  path: 'backend/runtimes/cloudflare/package.json',
  manifest: {
    devDependencies: {
      '@cloudflare/vitest-pool-workers': '^0.22.0',
      '@cloudflare/workers-types': '5.20260815.1',
      wrangler: '4.124.0',
    },
  },
}

const resolvedFromFixture = () => collectResolvedVersions(LOCKFILE)

test('reads one version per package from the packages section only', () => {
  const resolved = resolvedFromFixture()
  assert.deepEqual(resolved.get('wrangler'), ['4.124.0'])
  assert.deepEqual(resolved.get('workerd'), ['1.20260815.1'])
  assert.deepEqual(resolved.get('miniflare'), ['5.20260815.0-alpha'])
  // The snapshots section repeats every package with peer suffixes. Counting it too would report
  // a duplicate for every package in the tree, which is the shape of guard that gets disabled.
  assert.equal(resolved.get('wrangler').length, 1)
})

test('the overrides block is not mistaken for a resolution', () => {
  // `overrides:` sits above `packages:` and its entries are `name: version`, not `name@version:`.
  // A parser that took them would report the override's number as a second wrangler.
  assert.equal(resolvedFromFixture().get('wrangler').length, 1)
})

test('a tree with one of everything and exact pins is clean', () => {
  assert.deepEqual(
    findPinViolations({ resolved: resolvedFromFixture(), manifests: [cleanManifest] }),
    [],
  )
})

test('flags a second wrangler, which is how the tested and shipped runtimes diverge', () => {
  const resolved = resolvedFromFixture()
  resolved.set('wrangler', ['4.124.0', '4.125.0'])
  const violations = findPinViolations({ resolved, manifests: [cleanManifest] })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'duplicate')
})

test('flags a second workerd even when wrangler itself is single', () => {
  const resolved = resolvedFromFixture()
  resolved.set('workerd', ['1.20260815.1', '1.20260901.0'])
  const kinds = findPinViolations({ resolved, manifests: [cleanManifest] }).map((v) => v.kind)
  assert.ok(kinds.includes('duplicate'))
})

test('flags a second workers-types, which auto-installed optional peers reintroduce', () => {
  // The state this repo was actually in: every workspace declaration pinned exact, and
  // `autoInstallPeers` still filling drizzle-orm's and wrangler's optional peer slots from the
  // newest published version. Pinning the declarations alone does not catch it; counting does.
  const resolved = resolvedFromFixture()
  resolved.set('@cloudflare/workers-types', ['5.20260815.1', '5.20260823.1'])
  const violations = findPinViolations({ resolved, manifests: [cleanManifest] })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'duplicate')
})

test('flags a missing subject rather than passing vacuously', () => {
  const resolved = resolvedFromFixture()
  resolved.delete('miniflare')
  const violations = findPinViolations({ resolved, manifests: [cleanManifest] })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'missing')
})

test('flags a caret wrangler range, the state the override was papering over', () => {
  const violations = findPinViolations({
    resolved: resolvedFromFixture(),
    manifests: [
      {
        path: 'deploy/backend/package.json',
        manifest: { devDependencies: { wrangler: '^4.124.0' } },
      },
    ],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'wrangler-range')
})

test('flags an exact wrangler pin that disagrees with what resolved', () => {
  const violations = findPinViolations({
    resolved: resolvedFromFixture(),
    manifests: [
      {
        path: 'deploy/backend/package.json',
        manifest: { devDependencies: { wrangler: '4.123.0' } },
      },
    ],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'wrangler-version')
})

test('flags workers-types on a caret, which floats the types ahead of the runtime', () => {
  const violations = findPinViolations({
    resolved: resolvedFromFixture(),
    manifests: [
      {
        path: 'deploy/gatekeeper/package.json',
        manifest: { devDependencies: { '@cloudflare/workers-types': '^5.20260815.1' } },
      },
    ],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'types-range')
})

test('flags workers-types pinned exactly but to a later date than workerd', () => {
  const violations = findPinViolations({
    resolved: resolvedFromFixture(),
    manifests: [
      {
        path: 'deploy/backend/package.json',
        manifest: { devDependencies: { '@cloudflare/workers-types': '5.20260823.1' } },
      },
    ],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'types-date')
  assert.match(violations[0].message, /20260823.*20260815/s)
})

test('a peerDependencies range is exempt: a published library takes the consumer copy', () => {
  assert.deepEqual(
    findPinViolations({
      resolved: resolvedFromFixture(),
      manifests: [
        {
          path: 'sdk/gatekeeper-worker/package.json',
          manifest: {
            devDependencies: { '@cloudflare/workers-types': '5.20260815.1', wrangler: '4.124.0' },
            peerDependencies: { '@cloudflare/workers-types': '>=4' },
          },
        },
      ],
    }),
    [],
  )
})

test("a package declaring neither is not this guard's business", () => {
  assert.deepEqual(
    findPinViolations({
      resolved: resolvedFromFixture(),
      manifests: [
        {
          path: 'backend/packages/kernel/package.json',
          manifest: { devDependencies: { vitest: '^4.1.11' } },
        },
      ],
    }),
    [],
  )
})

test('releaseDateOf reads the workerd date component, and only from a dated version', () => {
  assert.equal(releaseDateOf('1.20260815.1'), '20260815')
  assert.equal(releaseDateOf('5.20260815.1'), '20260815')
  assert.equal(releaseDateOf('4.124.0'), null)
  assert.equal(releaseDateOf(''), null)
})
