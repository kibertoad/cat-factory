import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { extractManifestNamespace, imageEditArg, renderEnvFile } from '../src/deploy.js'
import { writeKubeconfig } from '../src/kubeconfig.js'

describe('imageEditArg', () => {
  it('builds a name=newName:newTag form', () => {
    expect(imageEditArg({ name: 'acme/app', newName: 'reg/app', newTag: 'pr-42' })).toBe(
      'acme/app=reg/app:pr-42',
    )
  })
  it('keeps the name when only a tag is overridden', () => {
    expect(imageEditArg({ name: 'acme/app', newTag: 'pr-42' })).toBe('acme/app=acme/app:pr-42')
  })
  it('builds a digest form', () => {
    expect(imageEditArg({ name: 'acme/app', digest: 'sha256:abc' })).toBe(
      'acme/app=acme/app@sha256:abc',
    )
  })
})

describe('renderEnvFile', () => {
  it('renders KEY=value lines with a trailing newline', () => {
    expect(
      renderEnvFile([
        { key: 'A', value: '1' },
        { key: 'B', value: 'two' },
      ]),
    ).toBe('A=1\nB=two\n')
  })
})

describe('extractManifestNamespace', () => {
  it('reads the namespace a workload declares under metadata', () => {
    const rendered = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
  namespace: shared-preview
data:
  namespace: not-this-one
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web
  name: web
  namespace: shared-preview
spec:
  replicas: 1
`
    expect(extractManifestNamespace(rendered)).toBe('shared-preview')
  })

  it('falls back to the first namespaced resource when there is no workload', () => {
    const rendered = `apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: team-a
`
    expect(extractManifestNamespace(rendered)).toBe('team-a')
  })

  it('ignores a namespace nested outside metadata (a ConfigMap data key)', () => {
    const rendered = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  namespace: app-config
`
    expect(extractManifestNamespace(rendered)).toBeNull()
  })

  it('returns null when no resource declares a namespace', () => {
    const rendered = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
`
    expect(extractManifestNamespace(rendered)).toBeNull()
  })
})

describe('writeKubeconfig', () => {
  it('renders a bearer-token kubeconfig with base64 CA and the context namespace', async () => {
    const { path, env } = await writeKubeconfig({
      apiServerUrl: 'https://c.example:6443',
      caCertPem: 'CA-PEM',
      token: 'tok',
      namespace: 'cf-env-1',
    })
    try {
      expect(env.KUBECONFIG).toBe(path)
      const cfg = JSON.parse(await readFile(path, 'utf8'))
      expect(cfg.clusters[0].cluster.server).toBe('https://c.example:6443')
      expect(cfg.clusters[0].cluster['certificate-authority-data']).toBe(
        Buffer.from('CA-PEM', 'utf8').toString('base64'),
      )
      expect(cfg.users[0].user.token).toBe('tok')
      expect(cfg.contexts[0].context.namespace).toBe('cf-env-1')
    } finally {
      await rm(dirname(path), { recursive: true, force: true })
    }
  })

  it('emits insecure-skip-tls-verify instead of a CA when requested', async () => {
    const { path } = await writeKubeconfig({
      apiServerUrl: 'https://c.example:6443',
      insecureSkipTlsVerify: true,
      token: 'tok',
      namespace: 'ns',
    })
    try {
      const cfg = JSON.parse(await readFile(path, 'utf8'))
      expect(cfg.clusters[0].cluster['insecure-skip-tls-verify']).toBe(true)
      expect(cfg.clusters[0].cluster['certificate-authority-data']).toBeUndefined()
    } finally {
      await rm(dirname(path), { recursive: true, force: true })
    }
  })
})
