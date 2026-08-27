import { HARNESS_JOB_PORT } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { runContainerEnv } from '../src/infrastructure/containers/RunContainer'
import type { Env } from '../src/infrastructure/env'

// What a per-run container is started WITH. The one invariant that is not merely configuration:
// the container is told which port to bind, so it cannot disagree with the `defaultPort` the
// class addresses. Without it the two are joined only by the image happening to default to the
// same number, and a deployment pins its own mirrored image tag, so an older one binds elsewhere
// and the container simply never answers.

const env = (over: Partial<Env> = {}): Env => ({ ...over }) as Env

describe('runContainerEnv', () => {
  it('states the port the harness must bind, matching the port the class addresses', () => {
    expect(runContainerEnv(env()).PORT).toBe(String(HARNESS_JOB_PORT))
  })

  it('states it whatever else is configured', () => {
    // The other two entries are conditional; this one may not become conditional with them.
    expect(runContainerEnv(env({ HARNESS_SHARED_SECRET: 'sek' })).PORT).toBe(
      String(HARNESS_JOB_PORT),
    )
  })

  it('passes the inbound-auth secret through when set, and omits it when not', () => {
    expect(runContainerEnv(env({ HARNESS_SHARED_SECRET: 'sek' })).HARNESS_SHARED_SECRET).toBe('sek')
    expect(runContainerEnv(env())).not.toHaveProperty('HARNESS_SHARED_SECRET')
  })

  it('carries no clone-host widening for a deployment with no GitLab instance', () => {
    expect(runContainerEnv(env())).not.toHaveProperty('GITHUB_ALLOWED_HOSTS')
  })
})
