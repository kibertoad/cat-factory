// Fixtures for `check-sdk-dependency-ranges.mjs`. Run with `node --test 'scripts/*.test.mjs'`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findPinnedSiblings } from './check-sdk-dependency-ranges.mjs'

const pkg = (fields) => ({ path: 'sdk/x/package.json', name: '@cat-factory/x', ...fields })
const specs = (manifests) => findPinnedSiblings(manifests).map(({ field, spec }) => [field, spec])

describe('findPinnedSiblings', () => {
  it('flags a workspace:* runtime dependency', () => {
    assert.deepEqual(specs([pkg({ dependencies: { '@cat-factory/sdk': 'workspace:*' } })]), [
      ['dependencies', 'workspace:*'],
    ])
  })

  it('flags an exact workspace version', () => {
    assert.deepEqual(
      specs([pkg({ optionalDependencies: { '@cat-factory/sdk': 'workspace:0.57.0' } })]),
      [['optionalDependencies', 'workspace:0.57.0']],
    )
  })

  it('accepts workspace:^ and workspace:~ on a runtime dependency', () => {
    const deps = { '@cat-factory/sdk': 'workspace:^', '@cat-factory/webhooks': 'workspace:~' }
    assert.deepEqual(specs([pkg({ dependencies: deps })]), [])
  })

  it('flags a peer that follows each release', () => {
    for (const spec of ['workspace:*', 'workspace:^', 'workspace:~']) {
      assert.deepEqual(specs([pkg({ peerDependencies: { '@cat-factory/sdk': spec } })]), [
        ['peerDependencies', spec],
      ])
    }
  })

  it('accepts a hand-written peer range', () => {
    const peers = { '@cat-factory/sdk': 'workspace:>=0.57.0 <1.0.0' }
    assert.deepEqual(specs([pkg({ peerDependencies: peers })]), [])
  })

  it('ignores devDependencies, registry ranges and private packages', () => {
    assert.deepEqual(
      specs([
        pkg({ devDependencies: { '@cat-factory/sdk': 'workspace:*' } }),
        pkg({ dependencies: { capnweb: '0.12.0' } }),
        pkg({ private: true, dependencies: { '@cat-factory/sdk': 'workspace:*' } }),
      ]),
      [],
    )
  })
})
