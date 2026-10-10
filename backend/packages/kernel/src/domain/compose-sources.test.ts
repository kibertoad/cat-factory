import type { ComposeSource } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  composeBaseDepth,
  composeProjectDir,
  composeSourcesNeedPrimaryRepo,
  describeComposeSource,
  materializedComposePath,
  normalizeComposeFileRefs,
} from './compose-sources.js'

describe('normalizeComposeFileRefs', () => {
  it('lifts the bare-path shorthand into an explicit path source and leaves objects alone', () => {
    expect(
      normalizeComposeFileRefs([
        'docker/dev.yml',
        { kind: 'inline', content: 'services: {}' },
        { kind: 'repo', repo: 'acme/infra', path: 'compose/shared.yml', ref: 'main' },
      ]),
    ).toEqual([
      { kind: 'path', path: 'docker/dev.yml' },
      { kind: 'inline', content: 'services: {}' },
      { kind: 'repo', repo: 'acme/infra', path: 'compose/shared.yml', ref: 'main' },
    ])
  })
})

describe('composeProjectDir / composeBaseDepth', () => {
  it('anchors on the first PATH layer, not the first layer of any kind', () => {
    // A prepended inline layer must NOT move the anchor to the checkout root: every relative
    // reference in the in-repo layers below it resolves against the project directory.
    const sources: ComposeSource[] = [
      { kind: 'inline', content: 'services: {}' },
      { kind: 'path', path: 'docker/dev.yml' },
      { kind: 'path', path: 'infra/other.yml' },
    ]
    expect(composeProjectDir(sources)).toBe('docker')
    expect(composeBaseDepth(sources)).toBe(1)
  })

  it('is the checkout root for a repo-less layer list (the strictest escape depth)', () => {
    const sources: ComposeSource[] = [
      { kind: 'repo', repo: 'acme/infra', path: 'deep/nested/compose.yml' },
      { kind: 'inline', content: 'services: {}' },
    ]
    expect(composeProjectDir(sources)).toBe('')
    // NOT 2 — a foreign layer's own depth must never widen what the host-escape guard tolerates
    // in the primary checkout.
    expect(composeBaseDepth(sources)).toBe(0)
  })

  it('reads a root-level compose file as depth 0', () => {
    expect(composeBaseDepth([{ kind: 'path', path: 'compose.yaml' }])).toBe(0)
  })
})

describe('materializedComposePath', () => {
  const projectDir = 'docker'

  it('leaves a path layer exactly where the repo put it', () => {
    expect(materializedComposePath({ kind: 'path', path: 'docker/dev.yml' }, 0, projectDir)).toBe(
      'docker/dev.yml',
    )
  })

  it('honours an inline layer that names its own path', () => {
    expect(
      materializedComposePath(
        { kind: 'inline', content: 'x', path: 'docker/extra.yml' },
        1,
        projectDir,
      ),
    ).toBe('docker/extra.yml')
  })

  it('generates a position-keyed path under the project dir for the rest', () => {
    expect(materializedComposePath({ kind: 'inline', content: 'x' }, 2, projectDir)).toBe(
      'docker/.cat-factory/compose/2-inline.yml',
    )
    expect(
      materializedComposePath(
        { kind: 'repo', repo: 'acme/infra', path: 'compose/shared.yml' },
        3,
        '',
      ),
    ).toBe('.cat-factory/compose/3-shared.yml')
  })

  it('keys generated paths by POSITION so same-named layers from different repos never collide', () => {
    const a = materializedComposePath({ kind: 'repo', repo: 'a/one', path: 'compose.yml' }, 0, '')
    const b = materializedComposePath({ kind: 'repo', repo: 'b/two', path: 'compose.yml' }, 1, '')
    expect(a).not.toBe(b)
  })

  it('sanitizes a foreign basename down to a safe filename stem', () => {
    expect(
      materializedComposePath({ kind: 'repo', repo: 'a/b', path: 'deploy/my stack!.yaml' }, 0, ''),
    ).toBe('.cat-factory/compose/0-my-stack.yml')
  })
})

describe('composeSourcesNeedPrimaryRepo', () => {
  it('is true as soon as one layer reads from the primary repo', () => {
    expect(
      composeSourcesNeedPrimaryRepo([
        { kind: 'inline', content: 'x' },
        { kind: 'path', path: 'compose.yaml' },
      ]),
    ).toBe(true)
  })

  it('is false for a list of only inline / foreign-repo layers', () => {
    expect(
      composeSourcesNeedPrimaryRepo([
        { kind: 'inline', content: 'x' },
        { kind: 'repo', repo: 'acme/infra', path: 'compose.yml' },
      ]),
    ).toBe(false)
  })
})

describe('describeComposeSource', () => {
  it('labels each kind legibly for a provisioning-log step name', () => {
    expect(describeComposeSource({ kind: 'path', path: 'docker/dev.yml' })).toBe('docker/dev.yml')
    expect(describeComposeSource({ kind: 'inline', content: 'x' })).toBe('inline')
    expect(describeComposeSource({ kind: 'inline', content: 'x', path: 'a.yml' })).toBe(
      'inline (a.yml)',
    )
    expect(
      describeComposeSource({ kind: 'repo', repo: 'acme/infra', path: 'c.yml', ref: 'v2' }),
    ).toBe('acme/infra@v2:c.yml')
  })
})
