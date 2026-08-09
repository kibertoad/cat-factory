import { describe, expect, it } from 'vitest'
import { canDesignateFrontend, frontendConfigForImport, planMonorepoImport } from './monorepoImport'

describe('canDesignateFrontend', () => {
  it('offers the mark for two or more backend services', () => {
    expect(canDesignateFrontend('service', 2)).toBe(true)
    expect(canDesignateFrontend('service', 5)).toBe(true)
  })

  it('withholds it below two directories: there is no rest to bind to', () => {
    expect(canDesignateFrontend('service', 1)).toBe(false)
    expect(canDesignateFrontend('service', 0)).toBe(false)
  })

  it('withholds it for roles a backend binding cannot point at', () => {
    // A binding's `service` source names a `service` frame; a library/document frame is not one,
    // and when everything is already a frontend the mark divides nothing.
    expect(canDesignateFrontend('library', 3)).toBe(false)
    expect(canDesignateFrontend('document', 3)).toBe(false)
    expect(canDesignateFrontend('frontend', 3)).toBe(false)
  })
})

describe('planMonorepoImport', () => {
  it('creates the marked directory as a frontend and the rest with the picked role', () => {
    expect(
      planMonorepoImport(['apps/web', 'services/api', 'services/auth'], 'service', 'apps/web'),
    ).toEqual([
      { directory: 'apps/web', type: 'frontend' },
      { directory: 'services/api', type: 'service' },
      { directory: 'services/auth', type: 'service' },
    ])
  })

  it('keeps the picked order, wherever the marked directory sits in it', () => {
    const plan = planMonorepoImport(['services/api', 'apps/web'], 'service', 'apps/web')
    expect(plan.map((e) => e.directory)).toEqual(['services/api', 'apps/web'])
    expect(plan[1]?.type).toBe('frontend')
  })

  it('gives every directory the picked role when nothing is marked', () => {
    expect(planMonorepoImport(['a', 'b'], 'service', undefined)).toEqual([
      { directory: 'a', type: 'service' },
      { directory: 'b', type: 'service' },
    ])
  })

  it('ignores a mark on a directory that is not being created', () => {
    // The cart entry was removed (or was already on the board and got filtered out) after being
    // marked. Designating nothing is right; promoting some other frame to frontend would not be.
    expect(planMonorepoImport(['a', 'b'], 'service', 'apps/web')).toEqual([
      { directory: 'a', type: 'service' },
      { directory: 'b', type: 'service' },
    ])
  })
})

describe('frontendConfigForImport', () => {
  it('binds the frontend to every backend created beside it, one binding each', () => {
    expect(frontendConfigForImport('apps/web', ['blk_api', 'blk_auth'])).toEqual({
      directory: 'apps/web',
      backendBindings: [
        { envVar: '', source: { kind: 'service', serviceBlockId: 'blk_api' } },
        { envVar: '', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
      ],
    })
  })

  it('carries the subdirectory: the harness builds the repo root without it', () => {
    // `frontendConfig.directory` is what the frontend infra spec reads; the service-level
    // directory that scopes an agent's checkout is a different field and does not stand in.
    expect(frontendConfigForImport('apps/web', []).directory).toBe('apps/web')
  })

  it('leaves every env var name empty rather than inventing one', () => {
    const config = frontendConfigForImport('apps/web', ['blk_api'])
    expect(config.backendBindings.every((b) => b.envVar === '')).toBe(true)
  })
})
