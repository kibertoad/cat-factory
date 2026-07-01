import { registerEnvironmentHandlerSchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  buildK3sHandler,
  buildK3sSetupUrl,
  DEFAULT_INGRESS_HOST_TEMPLATE,
  DEFAULT_NAMESPACE_TEMPLATE,
  KUBERNETES_ENV_TOKEN_SECRET_KEY,
} from './k3s-handler.js'
import { type ResolvedConnection } from './k3s-provision.js'

const CREATED: ResolvedConnection = {
  engine: 'local-k3s',
  clusterName: 'cat-factory',
  apiServerUrl: 'https://127.0.0.1:6443',
  apiToken: 'tok-abc',
  insecureSkipTlsVerify: true,
}

const REUSED: ResolvedConnection = {
  engine: 'local-k3s',
  apiServerUrl: 'https://127.0.0.1:6550',
  apiToken: 'tok-xyz',
  insecureSkipTlsVerify: true,
}

describe('buildK3sHandler', () => {
  it('produces a payload that satisfies the real registerEnvironmentHandler contract', () => {
    // The CLI mirrors the handler shape locally (no backend runtime dep); this parse is the guard
    // that keeps it from drifting from the actual contract schema.
    const parsed = v.parse(registerEnvironmentHandlerSchema, buildK3sHandler(CREATED))
    expect(parsed.provisionType).toBe('kubernetes')
    expect(parsed.config.engine).toBe('local-k3s')
  })

  it('wires the apiserver URL, skip-TLS, and per-PR namespace + ingress defaults', () => {
    const handler = buildK3sHandler(CREATED)
    expect(handler.config.kubernetes).toMatchObject({
      apiServerUrl: 'https://127.0.0.1:6443',
      insecureSkipTlsVerify: true,
      namespaceTemplate: DEFAULT_NAMESPACE_TEMPLATE,
      url: { source: 'ingressTemplate', hostTemplate: DEFAULT_INGRESS_HOST_TEMPLATE },
    })
  })

  it('carries the minted token ONLY in the write-only secret bundle', () => {
    const handler = buildK3sHandler(CREATED)
    expect(handler.secrets).toEqual({ [KUBERNETES_ENV_TOKEN_SECRET_KEY]: 'tok-abc' })
    // The token must never leak into the non-secret config.
    expect(JSON.stringify(handler.config)).not.toContain('tok-abc')
  })

  it('labels the connection with the created cluster name, or a plain label on reuse', () => {
    expect(buildK3sHandler(CREATED).config.kubernetes.label).toBe('Local k3s (cat-factory)')
    expect(buildK3sHandler(REUSED).config.kubernetes.label).toBe('Local k3s')
  })
})

describe('buildK3sSetupUrl', () => {
  it('deep-links the SPA with the NON-secret prefill params (never the token)', () => {
    const url = new URL(buildK3sSetupUrl('http://localhost:3000', buildK3sHandler(CREATED)))
    expect(url.origin).toBe('http://localhost:3000')
    expect(url.searchParams.get('infraSetup')).toBe('local-k3s')
    expect(url.searchParams.get('apiServerUrl')).toBe('https://127.0.0.1:6443')
    expect(url.searchParams.get('namespaceTemplate')).toBe(DEFAULT_NAMESPACE_TEMPLATE)
    expect(url.searchParams.get('hostTemplate')).toBe(DEFAULT_INGRESS_HOST_TEMPLATE)
    expect(url.searchParams.get('insecureSkipTlsVerify')).toBe('1')
    expect(url.searchParams.get('label')).toBe('Local k3s (cat-factory)')
    // A secret in a URL would leak into browser history — assert it never appears.
    expect(url.toString()).not.toContain('tok-abc')
  })

  it('preserves an app URL that already has a path/params', () => {
    const url = new URL(
      buildK3sSetupUrl('http://localhost:3000/board?x=1', buildK3sHandler(REUSED)),
    )
    expect(url.pathname).toBe('/board')
    expect(url.searchParams.get('x')).toBe('1')
    expect(url.searchParams.get('apiServerUrl')).toBe('https://127.0.0.1:6550')
  })
})
