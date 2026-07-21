import { CustomManifestTypeRegistry } from '@cat-factory/integrations'
import { BudgetedRepoScanner, type CheckoutFreeRepoReader } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  STACK_DEPLOY_MANIFEST_ID,
  detectStackDeployProvider,
  registerExampleStackDeployProvider,
} from './stack-deploy.js'

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

const detect = (files: Record<string, string>, directory?: string) =>
  detectStackDeployProvider({
    scanner: new BudgetedRepoScanner(makeReader(files), 200),
    ...(directory ? { directory } : {}),
  })

// A `deploy/stack.yml` shaped manifest: the deploy block carries the health probe + command.
const STACK_MANIFEST = `service: app
deploy:
  command: deploy/up.sh
  health:
    port: 8080
    path: /health
`

const STACK_REPO = {
  'deploy/stack.yml': STACK_MANIFEST,
  'deploy/up.sh': '#!/bin/bash',
  'deploy/compose.yml': 'services: {}',
}

describe('detectStackDeployProvider', () => {
  it('recognizes the 3-file signature and seeds health + deploy command', async () => {
    const rec = await detect(STACK_REPO)
    expect(rec).not.toBeNull()
    expect(rec).toMatchObject({
      matched: true,
      confidence: 'high',
      manifestPath: 'deploy/stack.yml',
    })
    expect(rec!.secondaryPaths).toEqual(['deploy/up.sh', 'deploy/compose.yml'])
    expect(rec!.configSeed).toEqual([
      { key: 'healthPort', value: '8080' },
      { key: 'healthPath', value: '/health' },
      { key: 'deployCommand', value: 'deploy/up.sh' },
    ])
  })

  it('returns null when the signature is incomplete', async () => {
    expect(await detect({ 'deploy/stack.yml': STACK_MANIFEST })).toBeNull()
  })

  it('matches under a monorepo service subtree', async () => {
    const nested = Object.fromEntries(
      Object.entries(STACK_REPO).map(([k, v]) => [`services/api/${k}`, v]),
    )
    const rec = await detect(nested, 'services/api')
    expect(rec).toMatchObject({ matched: true, manifestPath: 'services/api/deploy/stack.yml' })
  })

  it('still matches (config seed empty) when the manifest is templated / unparseable', async () => {
    const rec = await detect({
      'deploy/stack.yml': 'service: {{.Project}}\n{{ if eq .Env "main" }}\nx\n{{ end }}',
      'deploy/up.sh': '#!/bin/bash',
      'deploy/compose.yml': 'services: {}',
    })
    expect(rec).toMatchObject({ matched: true })
    expect(rec!.configSeed).toBeUndefined()
  })
})

describe('registerExampleStackDeployProvider', () => {
  it('registers the type with its detect() hook on the app-owned registry', () => {
    const registry = new CustomManifestTypeRegistry()
    registerExampleStackDeployProvider(registry)
    const type = registry.list().find((t) => t.manifestId === STACK_DEPLOY_MANIFEST_ID)
    expect(type).toBeTruthy()
    expect(type?.detect).toBe(detectStackDeployProvider)
    expect(type?.defaultManifestPath).toBe('deploy/stack.yml')
  })
})
