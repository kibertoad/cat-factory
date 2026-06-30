import { describe, expect, it } from 'vitest'
import { type InfraHandlerLike, resolveInfraHandler } from './infra-handler.logic.js'

function handler(
  overrides: Partial<InfraHandlerLike> & Pick<InfraHandlerLike, 'provisionType'>,
): InfraHandlerLike {
  return { manifestId: null, engine: 'remote-kubernetes', acceptsManifestId: null, ...overrides }
}

describe('resolveInfraHandler', () => {
  it('infraless short-circuits to the none engine with no handler', () => {
    const r = resolveInfraHandler({ type: 'infraless' }, [])
    expect(r).toEqual({ ok: true, engine: 'none', handler: null, fromUserOverride: false })
  })

  it('resolves a workspace handler by provision type', () => {
    const k8s = handler({ provisionType: 'kubernetes', engine: 'remote-kubernetes' })
    const compose = handler({ provisionType: 'docker-compose', engine: 'local-docker' })
    const r = resolveInfraHandler({ type: 'kubernetes' }, [k8s, compose])
    expect(r).toMatchObject({
      ok: true,
      engine: 'remote-kubernetes',
      handler: k8s,
      fromUserOverride: false,
    })
  })

  it('prefers a per-user override over the workspace handler', () => {
    const ws = handler({
      provisionType: 'kubernetes',
      engine: 'remote-kubernetes',
      manifestId: null,
    })
    const override = handler({ provisionType: 'kubernetes', engine: 'local-k3s' })
    const r = resolveInfraHandler({ type: 'kubernetes' }, [ws], [override])
    expect(r).toMatchObject({
      ok: true,
      engine: 'local-k3s',
      handler: override,
      fromUserOverride: true,
    })
  })

  it('returns no-handler when nothing serves the type', () => {
    const compose = handler({ provisionType: 'docker-compose', engine: 'local-docker' })
    expect(resolveInfraHandler({ type: 'kubernetes' }, [compose])).toEqual({
      ok: false,
      reason: 'no-handler',
    })
  })

  it('matches a pinned custom manifestId by key or acceptsManifestId', () => {
    const byKey = handler({ provisionType: 'custom', engine: 'remote-custom', manifestId: 'helm' })
    const byAccepts = handler({
      provisionType: 'custom',
      engine: 'remote-custom',
      manifestId: 'tf',
      acceptsManifestId: 'terraform',
    })
    expect(
      resolveInfraHandler({ type: 'custom', manifestId: 'helm' }, [byKey, byAccepts]),
    ).toMatchObject({
      ok: true,
      handler: byKey,
    })
    expect(
      resolveInfraHandler({ type: 'custom', manifestId: 'terraform' }, [byKey, byAccepts]),
    ).toMatchObject({ ok: true, handler: byAccepts })
  })

  it('resolves a bare custom declaration only when exactly one candidate exists', () => {
    const only = handler({ provisionType: 'custom', engine: 'remote-custom', manifestId: 'helm' })
    expect(resolveInfraHandler({ type: 'custom' }, [only])).toMatchObject({
      ok: true,
      handler: only,
    })
  })

  it('rejects an ambiguous bare custom declaration (type-mismatch)', () => {
    const a = handler({ provisionType: 'custom', engine: 'remote-custom', manifestId: 'helm' })
    const b = handler({ provisionType: 'custom', engine: 'remote-custom', manifestId: 'tf' })
    expect(resolveInfraHandler({ type: 'custom' }, [a, b])).toEqual({
      ok: false,
      reason: 'type-mismatch',
    })
  })

  it('returns no-handler for a custom manifestId no handler serves', () => {
    const helm = handler({ provisionType: 'custom', engine: 'remote-custom', manifestId: 'helm' })
    expect(resolveInfraHandler({ type: 'custom', manifestId: 'nope' }, [helm])).toEqual({
      ok: false,
      reason: 'no-handler',
    })
  })
})
