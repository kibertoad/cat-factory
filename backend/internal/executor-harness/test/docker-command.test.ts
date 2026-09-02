import { describe, expect, it } from 'vitest'
import { spawnDockerCommand } from '../src/docker-command.js'
import { silentLogger } from './helpers.js'

// The bounded spawn the docker checks run through. What is asserted here is what the callers rely
// on and what no amount of mocking above it can establish: that it NEVER rejects, whatever this
// machine has, and that an abandoned job never reaches the daemon at all.
//
// Deliberately machine-agnostic. Whether `docker` is on the PATH of the box running this suite is
// not a property of this module, and a case that assumed either answer would pass on a developer's
// laptop and fail on a runner (or the reverse) while pinning nothing.
//
// It also never touches a DAEMON, which is why the one real spawn below is the client-only
// `docker --version` rather than the `docker version` the module's caller uses. A unit suite that
// queues work on the shared daemon of whatever machine it runs on adds latency to every other
// file's docker call, and `infra-standup-docker.test.ts` is already spending real seconds there.

describe('running one docker command', () => {
  it('answers with an outcome rather than rejecting, whatever this machine has', async () => {
    // The caller classifies a spawn failure and a command that ran differently, and an exception
    // would collapse that distinction into whichever `catch` caught it first. Every branch above
    // this one is written against those two outcomes and nothing else.
    const outcome = await spawnDockerCommand(['--version'], {
      timeoutMs: 10_000,
      logger: silentLogger,
    })
    expect(['ran', 'failed']).toContain(outcome.outcome)
    if (outcome.outcome === 'failed') expect(outcome.reason).toBeTruthy()
  })

  it('does not spawn anything for a job that is already cancelled', async () => {
    // A cancelled run must not start a container, and the check that would is on the critical path
    // ahead of the clone. Asserted through the reason rather than a spy, because "nothing was
    // spawned" is only observable here as the answer arriving without one.
    const cancelled = AbortSignal.abort()
    const outcome = await spawnDockerCommand(['run', '--rm', 'whatever'], {
      timeoutMs: 10_000,
      signal: cancelled,
      logger: silentLogger,
    })
    expect(outcome).toEqual({
      outcome: 'failed',
      reason: 'the job was cancelled before `docker run` answered',
    })
  })
})
