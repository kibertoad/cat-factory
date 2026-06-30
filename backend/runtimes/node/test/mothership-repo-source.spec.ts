import { describe, expect, it } from 'vitest'
import { pickRepoSource } from '../src/container.js'

// The Phase-3 `db: undefined` audit seam (docs/initiatives/mothership-mode.md): every org/durable
// store a standard build constructs directly from the Drizzle `db` routes through
// `pickRepoSource`, so in mothership mode (no Postgres) it comes from the remote registry instead
// of an absent db. Pure unit coverage of that routing decision — the wiring (each site uses it
// with the matching repo name) is then kept honest by `tsc` + the no-Postgres build test.

describe('pickRepoSource (mothership direct-db routing seam)', () => {
  it('builds the Drizzle repo when there is no remote registry (standard db build)', () => {
    let built = false
    const repo = { tag: 'drizzle' }
    const result = pickRepoSource(undefined, 'notificationRepository', () => {
      built = true
      return repo
    })
    expect(built).toBe(true)
    expect(result).toBe(repo)
  })

  it('sources the named entry from the remote registry without building (mothership)', () => {
    const remoteEntry = { tag: 'remote-proxy' }
    const remote: Record<string, unknown> = { notificationRepository: remoteEntry }
    let built = false
    const result = pickRepoSource(remote, 'notificationRepository', () => {
      built = true
      return { tag: 'drizzle' }
    })
    // The remote entry is returned and the Drizzle builder is NEVER invoked (no db to build over).
    expect(built).toBe(false)
    expect(result).toBe(remoteEntry)
  })

  it('keys strictly by the requested name (a mismatched name resolves undefined, never the builder)', () => {
    const remote: Record<string, unknown> = { bootstrapJobRepository: { tag: 'remote' } }
    // A present remote registry means mothership mode — even an absent name must NOT fall back to
    // building a Drizzle repo over the (nonexistent) db; it resolves the registry slot as-is.
    const result = pickRepoSource(remote, 'notificationRepository', () => ({ tag: 'drizzle' }))
    expect(result).toBeUndefined()
  })
})
