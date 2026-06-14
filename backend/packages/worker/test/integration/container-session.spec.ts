import { describe, expect, it } from 'vitest'
import { ContainerSessionService } from '../../src/infrastructure/containers/ContainerSessionService'

// The container session token is the only credential a container holds for the
// LLM proxy; it must round-trip its claims, reject tampering/wrong keys, and
// expire. (Runs in workerd, so Web Crypto is the real implementation.)

const claims = {
  workspaceId: 'ws-1',
  executionId: 'ex-1',
  agentKind: 'coder',
  provider: 'qwen',
  model: 'qwen3-max',
}

describe('ContainerSessionService', () => {
  it('mints a token whose claims verify', async () => {
    const svc = new ContainerSessionService({ secret: 'top-secret' })
    const token = await svc.mint(claims)
    const session = await svc.verify(token)
    expect(session).toMatchObject(claims)
    expect(session!.exp).toBeGreaterThan(Date.now())
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await new ContainerSessionService({ secret: 'a' }).mint(claims)
    expect(await new ContainerSessionService({ secret: 'b' }).verify(token)).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const svc = new ContainerSessionService({ secret: 'top-secret' })
    const token = await svc.mint(claims)
    const [body, sig] = token.split('.')
    // Flip a character in the payload segment; the signature no longer matches.
    const tampered = `${body!.slice(0, -1)}${body!.slice(-1) === 'A' ? 'B' : 'A'}.${sig}`
    expect(await svc.verify(tampered)).toBeNull()
  })

  it('rejects an expired token', async () => {
    let now = 1_000_000
    const svc = new ContainerSessionService({ secret: 'top-secret', now: () => now })
    const token = await svc.mint({ ...claims, ttlMs: 1000 })
    now += 2000
    expect(await svc.verify(token)).toBeNull()
  })

  it('rejects missing/garbage tokens', async () => {
    const svc = new ContainerSessionService({ secret: 'top-secret' })
    expect(await svc.verify(null)).toBeNull()
    expect(await svc.verify('not-a-token')).toBeNull()
  })
})
