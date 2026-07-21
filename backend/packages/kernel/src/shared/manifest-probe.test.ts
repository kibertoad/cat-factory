import { describe, expect, it } from 'vitest'
import {
  allPresent,
  anyPresent,
  firstPresent,
  listFiles,
  matchManifestSignature,
  readYamlDoc,
  readYamlDocs,
} from './manifest-probe.logic.js'
import { BudgetedRepoScanner, type CheckoutFreeRepoReader } from './repo-scan.logic.js'

// In-memory checkout-free reader from a flat path→content map (dirs derived from the keys).
function makeReader(files: Record<string, string>): CheckoutFreeRepoReader {
  const paths = Object.keys(files)
  return {
    async getFile(path) {
      return path in files ? { content: files[path]! } : null
    },
    async listDirectory(path) {
      const prefix = path ? `${path}/` : ''
      const children = new Map<string, 'file' | 'dir'>()
      for (const full of paths) {
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        if (!rest) continue
        const slash = rest.indexOf('/')
        if (slash === -1) children.set(rest, 'file')
        else children.set(rest.slice(0, slash), 'dir')
      }
      return [...children].map(([name, type]) => ({ name, type, path: prefix + name }))
    },
  }
}

const scannerFor = (files: Record<string, string>) =>
  new BudgetedRepoScanner(makeReader(files), 200)

describe('manifest-probe presence combinators', () => {
  const files = { 'a.yml': '1', 'deployment/b.sh': '2', 'deployment/c.yml': '3' }

  it('allPresent is true only when every path exists', async () => {
    expect(await allPresent(scannerFor(files), ['a.yml', 'deployment/b.sh'])).toBe(true)
    expect(await allPresent(scannerFor(files), ['a.yml', 'missing.yml'])).toBe(false)
  })

  it('anyPresent / firstPresent short-circuit on the first hit', async () => {
    expect(await anyPresent(scannerFor(files), ['nope', 'a.yml'])).toBe(true)
    expect(await firstPresent(scannerFor(files), ['nope', 'deployment/c.yml'])).toBe(
      'deployment/c.yml',
    )
    expect(await firstPresent(scannerFor(files), ['nope', 'gone'])).toBeNull()
  })

  it('listFiles filters directory entries', async () => {
    const envFiles = await listFiles(
      scannerFor({ 'd/.env.app': '', 'd/.env.redis': '', 'd/x.txt': '' }),
      'd',
      (e) => e.name.startsWith('.env'),
    )
    expect(envFiles.map((e) => e.name).sort()).toEqual(['.env.app', '.env.redis'])
  })
})

describe('matchManifestSignature', () => {
  const stack = {
    'deploy/stack.yml': 'name: x',
    'deploy/up.sh': '#!/bin/bash',
    'deploy/compose.yml': 'services: {}',
  }

  it('matches a multi-file signature with high confidence', async () => {
    const m = await matchManifestSignature(scannerFor(stack), {
      required: ['deploy/stack.yml', 'deploy/up.sh', 'deploy/compose.yml'],
    })
    expect(m.matched).toBe(true)
    expect(m.confidence).toBe('high')
    expect(m.matchedPaths).toHaveLength(3)
    expect(m.missing).toEqual([])
  })

  it('reports the missing required files when not matched', async () => {
    const m = await matchManifestSignature(scannerFor({ 'deploy/stack.yml': 'x' }), {
      required: ['deploy/stack.yml', 'deploy/up.sh'],
    })
    expect(m.matched).toBe(false)
    expect(m.missing).toEqual(['deploy/up.sh'])
  })

  it('resolves paths under a monorepo root', async () => {
    const nested = {
      'services/api/deploy/stack.yml': 'x',
      'services/api/deploy/up.sh': 'x',
    }
    const m = await matchManifestSignature(
      scannerFor(nested),
      { required: ['deploy/stack.yml', 'deploy/up.sh'] },
      { root: 'services/api' },
    )
    expect(m.matched).toBe(true)
    expect(m.matchedPaths).toContain('services/api/deploy/stack.yml')
  })

  it('single-file match is low confidence; an optional hit raises it to high', async () => {
    const low = await matchManifestSignature(scannerFor({ 'only.yml': 'x' }), {
      required: ['only.yml'],
    })
    expect(low).toMatchObject({ matched: true, confidence: 'low' })

    const high = await matchManifestSignature(
      scannerFor({ 'only.yml': 'x', 'corroborate.txt': 'y' }),
      { required: ['only.yml'], optional: ['corroborate.txt'] },
    )
    expect(high).toMatchObject({ matched: true, confidence: 'high' })
  })

  it('anyOf group must be satisfied by at least one member', async () => {
    const m = await matchManifestSignature(scannerFor({ 'compose.yaml': 'x' }), {
      required: [],
      anyOf: [['compose.yaml', 'docker-compose.yml']],
    })
    expect(m.matched).toBe(true)
    const miss = await matchManifestSignature(scannerFor({ other: 'x' }), {
      required: [],
      anyOf: [['compose.yaml', 'docker-compose.yml']],
    })
    expect(miss.matched).toBe(false)
    expect(miss.missing[0]).toContain('compose.yaml | docker-compose.yml')
  })
})

describe('YAML helpers', () => {
  it('readYamlDoc parses a single document and returns null on absence or parse error', async () => {
    expect(await readYamlDoc(scannerFor({ 'x.yml': 'a: 1\nb: two' }), 'x.yml')).toEqual({
      a: 1,
      b: 'two',
    })
    expect(await readYamlDoc(scannerFor({}), 'missing.yml')).toBeNull()
    // A Go-templated manifest is not strict YAML — degrade to null, don't throw.
    expect(
      await readYamlDoc(scannerFor({ 't.yml': 'a: 1\n{{ if x }}\nbad\n{{ end }}' }), 't.yml'),
    ).toBeNull()
  })

  it('readYamlDocs parses a multi-document file', async () => {
    const docs = await readYamlDocs(scannerFor({ 'm.yml': 'kind: A\n---\nkind: B' }), 'm.yml')
    expect(docs).toEqual([{ kind: 'A' }, { kind: 'B' }])
  })
})
