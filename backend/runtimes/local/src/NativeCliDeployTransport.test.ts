import { describe, expect, it } from 'vitest'
import { NativeCliDeployTransport, buildLocalDeployTransport } from './NativeCliDeployTransport.js'

// `buildLocalDeployTransport` selects the local DEPLOY backend from the environment. Pure
// construction (no process spawn / container run happens until the first dispatch), so the
// selection logic is unit-testable directly.
describe('buildLocalDeployTransport', () => {
  it('defaults to native mode and is unwired without LOCAL_DEPLOY_HARNESS_ENTRY', () => {
    // No deploy backend configured ⇒ null, so the deploy lifecycle stays unwired (a
    // render-needing config fails loudly; the raw-manifest REST path is unaffected).
    expect(buildLocalDeployTransport({})).toBeNull()
    expect(buildLocalDeployTransport({ LOCAL_DEPLOY_RUNTIME: 'native' })).toBeNull()
  })

  it('builds the native deploy-harness host-process transport when its entry is set', () => {
    const t = buildLocalDeployTransport({ LOCAL_DEPLOY_HARNESS_ENTRY: '/srv/deploy/server.ts' })
    expect(t).toBeInstanceOf(NativeCliDeployTransport)
  })

  it('is unwired in container mode without LOCAL_DEPLOY_IMAGE', () => {
    expect(buildLocalDeployTransport({ LOCAL_DEPLOY_RUNTIME: 'container' })).toBeNull()
  })

  it('builds a job-scoped container transport when container mode + image are set', () => {
    const t = buildLocalDeployTransport({
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
})
