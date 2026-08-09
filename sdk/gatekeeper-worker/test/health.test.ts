// What `/health` is FOR, and the failure it exists to catch.
//
// The happy path is covered by `gatekeeper.spec.ts` against the suite's fully-bound Worker. What
// cannot be asserted there is a HALF-WIRED deployment, because the pool binds every var and secret
// the Worker reads. So these drive the factory's handler directly with an env an operator would
// actually produce: some bindings set, some not.
//
// The regression each pins is the same one. A health check that reports the two bindings the
// request path happens to read leaves an operator with a green monitor over a Gatekeeper whose
// every `/rpc` call answers 503, which is worse than no check at all: it is a check that agrees
// the deployment is fine.

import { describe, expect, it } from 'vitest'
import type { GatekeeperEnv } from '../src/env.js'
import { OS_EXPORTS } from '../src/os/exports.js'
import { createGatekeeperWorker } from '../src/worker.js'
import { FIXTURE_POLICY } from './fixture-policy.js'

const ORIGIN = 'https://gatekeeper.example.com'

/**
 * Every binding set, as a deployment that finished its wiring would have them.
 *
 * Declared as the full `GatekeeperEnv` so a binding added to the interface fails to compile here
 * until this fixture supplies it, and handed back widened so a spec can take one away.
 */
type PartialEnv = Partial<GatekeeperEnv>

function configured(): PartialEnv {
  const env: GatekeeperEnv = {
    CAT_FACTORY_BASE_URL: 'https://cat-factory.example.com',
    WEBHOOK_ID: 'gatekeeper',
    PUBLIC_URL: ORIGIN,
    PROVISIONING_KEY: 'cf_live_pak_provisioning.provisioning-secret',
    WEBHOOK_SECRET: 'test-webhook-secret-0123456789ab',
    OS_SHARED_TOKEN: 'test-os-shared-token',
    // Enough of a namespace for the assembly to name its object; the real Durable Object is what
    // `gatekeeper.spec.ts` runs against. What health asserts here is only that one is BOUND.
    STATE: {
      idFromName: (name: string) => name,
      get: () => ({}),
    } as unknown as GatekeeperEnv['STATE'],
  }
  return env
}

/**
 * A Worker whose entry module carries the four exports the Cloudflare OS object model resolves.
 *
 * The second half of "is this deployment wired": the bindings say whether it can talk to the
 * paired deployment, and these say whether a workspace can discover and install it. Both are
 * things an operator can half-finish, and only one of them has a request path of its own.
 */
function exported(): Record<string, () => unknown> {
  return Object.fromEntries(Object.values(OS_EXPORTS).map((name) => [name, () => ({})]))
}

async function health(
  env: PartialEnv,
  exports: Record<string, unknown> = exported(),
): Promise<Response> {
  const worker = createGatekeeperWorker({ policy: FIXTURE_POLICY })
  const response = await worker.fetch?.(
    new Request(`${ORIGIN}/health`),
    env as GatekeeperEnv,
    {
      exports,
    } as unknown as ExecutionContext,
  )
  if (response === undefined) throw new Error('the Worker returned no response')
  return response
}

describe('GET /health', () => {
  it('is green only when every binding is set and the object model is exported', async () => {
    const response = await health(configured())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  // The two the assembly reads on its own (`CAT_FACTORY_BASE_URL`, `PROVISIONING_KEY`) were the
  // whole of the old check. A Gatekeeper missing only the shared token authorizes nobody.
  it.each([
    'CAT_FACTORY_BASE_URL',
    'WEBHOOK_ID',
    'PUBLIC_URL',
    'PROVISIONING_KEY',
    'WEBHOOK_SECRET',
    'OS_SHARED_TOKEN',
    'STATE',
  ] as const)('refuses when %s alone is unset, and names it', async (binding) => {
    const env = configured()
    delete env[binding]

    const response = await health(env)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    expect(body.error.reason).toBe('not_configured')
    expect(body.error.message).toContain(binding)
  })

  // One pass over the whole table, not the first name the path tripped on: an operator who has to
  // redeploy to learn the next unset binding fixes a half-wired deployment one restart at a time.
  it('names every unset binding at once, each with the mechanism it takes', async () => {
    const env = configured()
    delete env.PUBLIC_URL
    delete env.WEBHOOK_SECRET

    const message = ((await (await health(env)).json()) as { error: { message: string } }).error
      .message
    expect(message).toContain('PUBLIC_URL (set it as a var in wrangler.toml)')
    expect(message).toContain('WEBHOOK_SECRET (put it with `wrangler secret put WEBHOOK_SECRET`')
  })

  // A perfectly bound Worker whose entry module is three lines short is undiscoverable, and that
  // failure has no request path of its own: a workspace simply never finishes installing it, which
  // is not a call anyone monitors.
  it('refuses when the object model is not exported, naming every missing export', async () => {
    const exports = exported()
    delete exports[OS_EXPORTS.account]
    delete exports[OS_EXPORTS.resource]

    const response = await health(configured(), exports)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    expect(body.error.reason).toBe('not_configured')
    expect(body.error.message).toContain(OS_EXPORTS.account)
    expect(body.error.message).toContain(OS_EXPORTS.resource)
    expect(body.error.message).not.toContain(OS_EXPORTS.vendor)
  })

  // A secret named as something to write in wrangler.toml is how an admin key reaches a
  // repository. The remedy a refusal ends on is the one an operator will follow.
  it('never tells an operator to put a credential in wrangler.toml', async () => {
    const env = configured()
    delete env.PROVISIONING_KEY

    const message = ((await (await health(env)).json()) as { error: { message: string } }).error
      .message
    expect(message).toContain('`wrangler secret put PROVISIONING_KEY`, never in wrangler.toml')
  })
})
