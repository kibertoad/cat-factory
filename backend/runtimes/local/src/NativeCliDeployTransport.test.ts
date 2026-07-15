import { describe, expect, it } from 'vitest'
import { NativeCliDeployTransport, buildLocalDeployTransport } from './NativeCliDeployTransport.js'

// The harness inbound-auth secret is a REQUIRED constructor argument on every runner transport,
// so a build path (native entry set / container image set) needs it in the env; the deploy-unused
// paths that return null must not.
const SECRET = { HARNESS_SHARED_SECRET: 'deploy-test-harness-secret' }

// `buildLocalDeployTransport` selects the local DEPLOY backend from the environment. Pure
// construction (no process spawn / container run happens until the first dispatch), so the
// selection logic is unit-testable directly.
describe('buildLocalDeployTransport', () => {
  it('is unwired (null) when LOCAL_DEPLOY_RUNTIME is unset — deploy simply not used', () => {
    // No mode set ⇒ null with NO error, so the deploy lifecycle stays unwired (a render-needing
    // config fails loudly at provision time; the raw-manifest REST path is unaffected). This is
    // the common state for a local deployment that doesn't stand Kubernetes test environments up.
    expect(buildLocalDeployTransport({})).toBeNull()
  })

  it('builds the native deploy-harness host-process transport when native + entry are set', () => {
    const t = buildLocalDeployTransport({
      ...SECRET,
      LOCAL_DEPLOY_RUNTIME: 'native',
      LOCAL_DEPLOY_HARNESS_ENTRY: '/srv/deploy/server.ts',
    })
    expect(t).toBeInstanceOf(NativeCliDeployTransport)
  })

  it('builds a job-scoped container transport when container mode + image are set', () => {
    const t = buildLocalDeployTransport({
      ...SECRET,
      LOCAL_DEPLOY_RUNTIME: 'container',
      LOCAL_DEPLOY_IMAGE: 'ghcr.io/acme/cat-factory-deploy:0.2.2',
    })
    // Not the native host-process transport, and a usable RunnerTransport (dispatch/poll/release).
    expect(t).not.toBeNull()
    expect(t).not.toBeInstanceOf(NativeCliDeployTransport)
    expect(typeof t!.dispatch).toBe('function')
    expect(typeof t!.poll).toBe('function')
    expect(typeof t!.release).toBe('function')
  })

  it('BREAKS (throws) on native mode without LOCAL_DEPLOY_HARNESS_ENTRY — no silent fallback', () => {
    // The brittle, must-be-configured mode: a missing companion var is a boot-breaking
    // misconfiguration, not a request for a silently-unwired deploy.
    expect(() => buildLocalDeployTransport({ LOCAL_DEPLOY_RUNTIME: 'native' })).toThrow(
      /LOCAL_DEPLOY_HARNESS_ENTRY/,
    )
  })

  it('BREAKS (throws) on container mode without LOCAL_DEPLOY_IMAGE', () => {
    expect(() => buildLocalDeployTransport({ LOCAL_DEPLOY_RUNTIME: 'container' })).toThrow(
      /LOCAL_DEPLOY_IMAGE/,
    )
  })

  it('BREAKS (throws) on an unrecognised LOCAL_DEPLOY_RUNTIME value — no fallback to native', () => {
    expect(() => buildLocalDeployTransport({ LOCAL_DEPLOY_RUNTIME: 'containr' })).toThrow(
      /not a recognised value/i,
    )
  })
})
