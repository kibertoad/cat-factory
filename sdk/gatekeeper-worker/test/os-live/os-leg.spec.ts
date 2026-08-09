// The object model, driven by a REAL Cloudflare OS workspace.
//
// Everything on our side is real and so is everything on theirs: `workshop-backend` and this
// Worker boot together under wrangler's own test harness, and the specs speak Cap'n Web over a
// WebSocket to `/api` exactly as the workspace's browser does. What is absent is only the UI
// around it.
//
// This leg exists for the seams no suite in this repo structurally can reach, and there are three:
//
//   - THE ENTRYPOINT NAMES. The workspace resolves `GatekeeperVendor` off a service binding and
//     never asks this package what it is called. A rename is invisible to every hermetic spec and
//     undiscoverable in production.
//   - THE STUBS WE HAND OVER. `createAccount()` returns something the workspace PERSISTS, and
//     `getGatekeeperClassFor()` returns a Durable Object class only the workspace's own machinery
//     can instantiate. The hermetic suite drives a `ResourceCore` for exactly that reason, so the
//     shell around it, and the props-imbued construction the workspace performs, are pinned here
//     or nowhere.
//   - THE TRANSCRIBED PROTOCOL. `src/os/protocol.ts` is a transcription of a partner file, kept
//     honest by nothing but this run: a shape that drifted still compiles here and fails there.
//
// What it deliberately does NOT reach is a session. The harness drops the Worker Loader (a
// gatekeeper is in observer scope purely by having a vendor id), so no gadget code runs and
// `startSession` is never called. The approval queue, the argument checks and the answerers stay
// where they already are: in the hermetic suite, against a scripted workspace that can be made to
// refuse on command. Two legs, two questions.
//
// The cat-factory deployment is faked here by ABSENCE rather than by a script: every path a
// workspace drives on this Worker is served from the policy and the Durable Object, so the network
// interceptor carries no handlers at all and any outbound request is a failure. That is a claim
// worth making, not a convenience: a regression that made `describe()` probe the deployment would
// put a live credential on a path the workspace calls before any approval exists.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHarness, type Harness } from '@gadgets/integration-tests/harness'
import { NetworkInterceptor } from '@gadgets/integration-tests/network-interceptor'
import {
  connect,
  listConnectedAccounts,
  MAX_OBSERVER_PROMPTS,
  nextUsernames,
  ObserverConfigRecorder,
  signUp,
  stubFor,
  waitFor,
} from '@gadgets/integration-tests/rpc-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** The package's own test directory: `wrangler.jsonc` there is the Worker all three suites boot. */
const GATEKEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The one root that contains both Workers: this repository, with the partner clone inside it. */
const REPO_ROOT = resolve(GATEKEEPER_DIR, '../../..')

/**
 * The service binding suffix, and therefore the vendor id the workspace derives from it.
 *
 * `GATEKEEPER_CAT_FACTORY` is the name the Gatekeeper's own documentation tells an operator to
 * bind, so the suite uses it rather than a shorter one: the lowercased suffix is what every RPC
 * carries, and a suite that bound `CF` would be testing a vendor id no deployment has.
 */
const BINDING = 'CAT_FACTORY'
const VENDOR_ID = BINDING.toLowerCase()

/** The paired deployment. Never reached: it exists so the resource pattern has an origin. */
const DEPLOYMENT = 'https://cat-factory.example.com'

/** The tier `FIXTURE_POLICY` gives an auto-provisioned account, which is what an OS account gets. */
const OS_TIER = 'workspace'

let harness: Harness
let interceptor: NetworkInterceptor

beforeAll(async () => {
  interceptor = new NetworkInterceptor()
  interceptor.install()
  harness = await startHarness({
    root: REPO_ROOT,
    gatekeepers: [
      {
        binding: BINDING,
        dir: GATEKEEPER_DIR,
        // The bindings a deployment supplies, as ordinary vars: three of them are secrets in a real
        // deployment, and none of them is reachable from here anyway, because nothing this leg
        // drives makes an upstream call. What they have to be is PRESENT, since the Worker refuses
        // a request naming any binding it has not been given.
        patch: (config) => {
          config.vars = {
            ...config.vars,
            CAT_FACTORY_BASE_URL: DEPLOYMENT,
            PUBLIC_URL: 'https://gatekeeper.cat-factory.invalid',
            WEBHOOK_ID: 'gatekeeper-os-leg',
            PROVISIONING_KEY: 'cf_live_pak_provisioning.provisioning-secret',
            WEBHOOK_SECRET: 'os-leg-webhook-secret-0123456789ab',
            OS_SHARED_TOKEN: 'os-leg-shared-token',
          }
        },
      },
    ],
  })
})

afterAll(async () => {
  // Asserted once for the whole file rather than per case: the cases run concurrently, so an
  // `afterEach` would inspect state a sibling is still producing.
  const unmocked = interceptor.getUnmockedCalls()
  await harness?.server.close()
  interceptor.uninstall()
  interceptor.reset()
  expect(unmocked).toEqual([])
})

/** Each case gets its own RPC session, so a disposal in one cannot disturb another. */
async function withSession<T>(body: (api: Awaited<ReturnType<typeof connect>>) => Promise<T>) {
  const publicApi = connect(harness.url)
  try {
    return await body(publicApi)
  } finally {
    publicApi[Symbol.dispose]()
  }
}

type WorkspaceUser = Awaited<ReturnType<typeof signUp>>
type Gadget = Awaited<ReturnType<WorkspaceUser['newGadget']>>

/**
 * Run `body` against a fresh gadget, disposing the stub afterwards whatever the body did.
 *
 * A case that can hold its gadget to the end says so with a `using` binding, and most here do. The
 * sharing case cannot: it has to CLOSE the owner's gadget before the collaborator opens it, so the
 * stub's life ends partway through the case rather than at its edge. Disposing in a `finally` is
 * what keeps a failed assertion before that point from leaking the stub against the harness every
 * case shares, which turns one red assertion into a teardown that waits out the 120s hook timeout
 * and reports the leak instead of the failure.
 */
async function withGadget<T>(
  user: WorkspaceUser,
  body: (overseer: Gadget) => Promise<T>,
): Promise<T> {
  const overseer = await user.newGadget()
  try {
    return await body(overseer)
  } finally {
    overseer[Symbol.dispose]()
  }
}

/**
 * Sign a fresh user up and let the workspace mint them a cat-factory account.
 *
 * `provisionAmbientAccount` is the workspace's side of `createAccount()`: it is offered only for a
 * vendor whose `describe()` reports `autoProvisionsAccount`, so reaching an account through it at
 * all is the assertion that ours does.
 */
async function newUserWithAccount(api: Awaited<ReturnType<typeof connect>>, prefix: string) {
  const [username] = nextUsernames(prefix)
  const user = await signUp(api, username)
  await user.provisionAmbientAccount(VENDOR_ID)
  const account = await waitFor('the cat-factory account to be provisioned', async () => {
    const accounts = await listConnectedAccounts(user)
    return accounts.find((candidate) => candidate.vendorId === VENDOR_ID) ?? null
  })
  return { username, user, account }
}

describe('discovery and account provisioning', () => {
  it.concurrent('mints an account the workspace can persist, name and resolve a tier for', async () => {
    await withSession(async (publicApi) => {
      const { account } = await newUserWithAccount(publicApi, 'minted')

      // The account arrived at all, which means the vendor was discovered off the binding, its
      // `describe()` crossed native RPC, and the stub `createAccount()` handed back survived being
      // persisted and re-read by the workspace.
      expect(account.credentialsValid).toBe(true)
      // The id this Gatekeeper minted, surfaced as the canonical name because it is the value an
      // operator needs in hand to raise one account above the auto-provisioned tier.
      expect(account.description.uniqueName).toMatch(/^acct_[0-9a-f]{32}$/)
      // Resolved through `autoProvisionedTier`, never `defaultTier` (which this policy leaves
      // null, so a stranger on `/rpc` is refused). The two knobs are separate on purpose.
      expect(account.description.displayName).toContain(OS_TIER)
    })
  })

  it.concurrent('gives each workspace user an account of their own', async () => {
    await withSession(async (publicApi) => {
      const first = await newUserWithAccount(publicApi, 'distincta')
      const second = await newUserWithAccount(publicApi, 'distinctb')

      // `createAccount()` takes no arguments by design, so it cannot look an existing account up.
      // Two users getting one account would mean two people's runs attributed to one identity.
      expect(second.account.description.uniqueName).not.toBe(first.account.description.uniqueName)
    })
  })
})

describe('binding the paired workspace as a resource', () => {
  it.concurrent('binds a URL inside the pattern and describes it through the resource object', async () => {
    await withSession(async (publicApi) => {
      const { user, account } = await newUserWithAccount(publicApi, 'binder')
      using overseer = await user.newGadget()

      using bound = await overseer.newGatekeeper(account.id, `${DEPLOYMENT}/w/demo`)
      expect(bound).not.toBeNull()

      // The workspace instantiated the Durable Object class `getGatekeeperClassFor()` returned and
      // called `describe()` on it: this title comes from the resource object, not from the vendor's
      // own listing, so it is the shell around `ResourceCore` answering.
      await expect(overseer.listObserverRequirements('build')).resolves.toEqual([
        expect.objectContaining({
          gatekeeperId: await bound!.getId(),
          vendorId: VENDOR_ID,
          resourceTitle: 'cat-factory workspace',
          // The resource's OWN url, not the one the bind asked for. Every URL under the pattern
          // names the same paired workspace, so the resource object describes itself by the
          // deployment rather than echoing back what a person happened to paste, and the workspace
          // takes the description's word for it.
          resourceUrl: DEPLOYMENT,
        }),
      ])
    })
  })

  it.concurrent('refuses a URL it does not serve, saying what it does serve', async () => {
    await withSession(async (publicApi) => {
      const { user, account } = await newUserWithAccount(publicApi, 'stranger')
      using overseer = await user.newGadget()

      // One Gatekeeper serves one workspace, because the provisioning key it holds is scoped to
      // one. A bind that silently succeeded against the wrong deployment is the failure this
      // refusal exists to prevent, and it has to reach the workspace as an error rather than as a
      // connection that fails later.
      await expect(
        overseer.newGatekeeper(account.id, 'https://elsewhere.example.com/w/demo'),
      ).rejects.toThrow(/and nothing else/)
    })
  })
})

describe('sharing a bound resource', () => {
  it.concurrent('refuses a collaborator with the reason the observer rule gave', async () => {
    await withSession(async (publicApi) => {
      const owner = await newUserWithAccount(publicApi, 'owner')
      const viewer = await newUserWithAccount(publicApi, 'viewer')

      // The owner's gadget is closed at the end of this block, before the viewer opens it below.
      const gadgetId = await withGadget(owner.user, async (overseer) => {
        using bound = await overseer.newGatekeeper(owner.account.id, `${DEPLOYMENT}/w/shared`)
        expect(bound).not.toBeNull()
        const { id } = await overseer.getMetadata()
        const collaborator = await overseer.addCollaborator(viewer.username, 'build')
        if (!collaborator) throw new Error(`sharing the gadget with ${viewer.username} failed`)
        return id
      })

      // Opening as a collaborator is what drives `addObserver` on the resource object with the
      // viewer's own verifier. This tier can read captured agent text, which is described
      // `prohibitAllSharing`: a statement about the DATA rather than about the viewer, so no
      // account can be admitted and the refusal is the one that must reach a person. The admitting
      // half of the rule is pinned in `test/sharing.test.ts`, where a tier without the telemetry
      // operations can be built without rebuilding this Worker.
      const recorder = new ObserverConfigRecorder().alwaysChoose(
        viewer.account.id,
        MAX_OBSERVER_PROMPTS,
      )
      const callback = stubFor(recorder)
      try {
        const error = await viewer.user.openGadget(gadgetId, undefined, callback).then(
          (opened: { [Symbol.dispose](): void }) => {
            opened[Symbol.dispose]()
            return null
          },
          (thrown: unknown) => thrown as Error,
        )

        expect(error).not.toBeNull()
        expect(error!.message).toContain('captured agent text')
      } finally {
        callback[Symbol.dispose]()
      }
    })
  })
})
