import { describe, expect, it } from 'vitest'
import type { CreatedMonorepoFrame } from './monorepoImport'
import {
  canDesignateFrontend,
  planFrontendConfigPatches,
  planMonorepoImport,
} from './monorepoImport'

/** Pair a plan with block ids, the way the modal does as each create call returns. */
function created(entries: ReturnType<typeof planMonorepoImport>): CreatedMonorepoFrame[] {
  return entries.map((entry, i) => ({ blockId: `blk_${i}`, entry }))
}

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
      { directory: 'apps/web', type: 'frontend', designatedFrontend: true },
      { directory: 'services/api', type: 'service', designatedFrontend: false },
      { directory: 'services/auth', type: 'service', designatedFrontend: false },
    ])
  })

  it('keeps the picked order, wherever the marked directory sits in it', () => {
    const plan = planMonorepoImport(['services/api', 'apps/web'], 'service', 'apps/web')
    expect(plan.map((e) => e.directory)).toEqual(['services/api', 'apps/web'])
    expect(plan[1]?.type).toBe('frontend')
  })

  it('gives every directory the picked role when nothing is marked', () => {
    expect(planMonorepoImport(['a', 'b'], 'service', undefined)).toEqual([
      { directory: 'a', type: 'service', designatedFrontend: false },
      { directory: 'b', type: 'service', designatedFrontend: false },
    ])
  })

  it('ignores a mark on a directory that is not being created', () => {
    // The cart entry was removed (or was already on the board and got filtered out) after being
    // marked. Designating nothing is right; promoting some other frame to frontend would not be.
    expect(planMonorepoImport(['a', 'b'], 'service', 'apps/web')).toEqual([
      { directory: 'a', type: 'service', designatedFrontend: false },
      { directory: 'b', type: 'service', designatedFrontend: false },
    ])
  })

  it('designates nobody when the whole cart is imported under the frontend role', () => {
    // Every entry is `type: 'frontend'` here, so the flag is the ONLY thing that separates
    // "the app the others talk to" from "a cart of frontends". A mark is never on offer for this
    // role (`canDesignateFrontend`), and one carried over from a role change must not act.
    const plan = planMonorepoImport(['apps/web', 'apps/admin'], 'frontend', 'apps/web')
    expect(plan.every((e) => e.type === 'frontend')).toBe(true)
    expect(plan.some((e) => e.designatedFrontend)).toBe(false)
  })
})

describe('planFrontendConfigPatches', () => {
  it('binds the designated frontend to every other frame created beside it', () => {
    const plan = planMonorepoImport(
      ['apps/web', 'services/api', 'services/auth'],
      'service',
      'apps/web',
    )
    expect(planFrontendConfigPatches(created(plan))).toEqual([
      {
        blockId: 'blk_0',
        config: {
          directory: 'apps/web',
          backendBindings: [
            { envVar: '', source: { kind: 'service', serviceBlockId: 'blk_1' } },
            { envVar: '', source: { kind: 'service', serviceBlockId: 'blk_2' } },
          ],
        },
      },
    ])
  })

  it('leaves every env var name empty rather than inventing one', () => {
    const plan = planMonorepoImport(['apps/web', 'services/api'], 'service', 'apps/web')
    const [patch] = planFrontendConfigPatches(created(plan))
    expect(patch?.config.backendBindings.every((b) => b.envVar === '')).toBe(true)
  })

  it('carries the subdirectory to every frontend frame, designated or not', () => {
    // `frontendConfig.directory` is what the harness's install/build/serve reads; the service-level
    // directory that scopes an agent's checkout is a different field and does not stand in. A cart
    // imported under the `frontend` role has no designated frame, and every frame in it would
    // otherwise build the repo root.
    const plan = planMonorepoImport(['apps/web', 'apps/admin'], 'frontend', undefined)
    expect(planFrontendConfigPatches(created(plan))).toEqual([
      { blockId: 'blk_0', config: { directory: 'apps/web', backendBindings: [] } },
      { blockId: 'blk_1', config: { directory: 'apps/admin', backendBindings: [] } },
    ])
  })

  it('patches nothing when the import creates no frontend frame', () => {
    const plan = planMonorepoImport(['services/api', 'services/auth'], 'service', undefined)
    expect(planFrontendConfigPatches(created(plan))).toEqual([])
  })
})
