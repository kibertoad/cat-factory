import { describe, expect, it } from 'vitest'
import { ConflictError, getErrorReason } from '@cat-factory/kernel'
import { noRunnerBackendAvailableError } from '../src/runtime/runnerBackendError.js'

// D3: the "no runner backend available" failure is one shared, tested factory both facades throw,
// so the Cloudflare and Node/local resolvers can't drift. It is a ConflictError carrying the
// machine reason so the SPA renders "Agent backend not configured" (not "container failed to
// start") on both the synchronous 409 and the async dispatch path.
describe('noRunnerBackendAvailableError', () => {
  it('is a ConflictError carrying the agent_backend_unconfigured reason', () => {
    const err = noRunnerBackendAvailableError('ws-1')
    expect(err).toBeInstanceOf(ConflictError)
    expect(getErrorReason(err)).toBe('agent_backend_unconfigured')
  })

  it('preserves the load-bearing prefix, names the UI path first, and links the doc', () => {
    const { message } = noRunnerBackendAvailableError('ws-1')
    expect(message).toMatch(/^No runner backend available for workspace 'ws-1'/)
    expect(message).toContain('Settings → Self-hosted runner pool')
    expect(message).toContain('runner-pool-integration.md')
  })

  it('falls back to (unknown) when the workspace id is absent', () => {
    expect(noRunnerBackendAvailableError(undefined).message).toContain("workspace '(unknown)'")
  })

  it('offers the Cloudflare Containers remedy only for the Cloudflare facade', () => {
    expect(noRunnerBackendAvailableError('ws-1', { cloudflareContainers: true }).message).toContain(
      'enable Cloudflare Containers',
    )
    // The Node/local facades have no per-run container backend, so they never suggest it.
    expect(noRunnerBackendAvailableError('ws-1').message).not.toContain('Cloudflare Containers')
  })
})
