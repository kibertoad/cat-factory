import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { imageEditArg, renderEnvFile } from '../src/deploy.js'
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
