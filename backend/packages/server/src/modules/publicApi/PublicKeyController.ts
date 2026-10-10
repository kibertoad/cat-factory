import type { PublicApiKeyRecord } from '@cat-factory/kernel'
import {
  createPublicKeyContract,
  listPublicKeysContract,
  revokePublicKeyContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import {
  assertReachCovers,
  assertWorkspacesInAccount,
  publicApiKeyToWire,
} from './keyProjection.js'
import { authorize, refuse } from './publicApiAuth.js'

// HEADLESS key provisioning (`GET|POST|DELETE /api/v1/keys`): the external counterpart of the
// session-authed `/workspaces/:ws/public-api-keys` routes, delegating to the SAME
// `PublicApiKeyService` so the per-workspace cap, the one-way secret hash and the revocation
// cascade cannot differ by surface.
//
// The gap it closes is the one the outbound webhook had
// (`backend/docs/adr/0043-public-decision-surface.md`): a deployment whose operator is headless
// could drive every part
// of this API except the act of GETTING a key, so an integration provisioning per-tenant or
// per-environment credentials had to route a human through the browser for each one.
//
// Two bounds make that safe, and they are the whole security argument:
//
//  1. **A minted key can never reach the rung minting requires.** The gate is
//     `HEADLESS_KEY_MINT_SCOPE` (`admin`) and the mintable set is every rung strictly below it,
//     so the mint chain is exactly one link long. There is deliberately NO runtime check that
//     the requested scope is ≤ the caller's: the contract's picklist is the enforcement, and a
//     hand-written second copy of the rule is how the two drift.
//  2. **Revoking a key revokes everything it minted** (`PublicApiKeyService.revoke`). Without
//     that, a leaked provisioning key would survive its own revocation through the keys it left
//     behind: the operator kills the credential they can see, and the ones the attacker made
//     keep working.
//
// What this surface still cannot do, deliberately: mint an `admin` key (that needs a human
// session and the `secrets.manage` workspace permission), or reach another workspace: every
// route is bound to the calling key's own.

/**
 * The key store. `authorize` has already proven it is wired (it resolves the caller's key
 * through it and answers 503 when it is absent), so this is the total accessor that carries that
 * fact into the handler's types rather than a second refusal a reader has to reconcile with the
 * first.
 */
function keyStore<E extends AppEnv>(c: Context<E>) {
  return requireCapability(c.get('container').publicApiKeys, 'Public API is not configured')
}

/**
 * The rung an omitted `scope` mints at. Stated here rather than as a schema default because a
 * default in a request body ships to four generated SDKs as "always present", which is the
 * opposite of what an optional field means on the way in.
 */
const DEFAULT_MINTED_SCOPE = 'write' as const

export function publicKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPublicKeysContract, async (c) => {
    const gate = await authorize(c, listPublicKeysContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { accountId, workspaceId } = gate.auth
    const keys = await keyStore(c).listReaching(accountId, workspaceId)
    return c.json(
      { keys: keys.map((key: PublicApiKeyRecord) => publicApiKeyToWire(key, workspaceId)) },
      200,
    )
  })

  buildHonoRoute(app, createPublicKeyContract, async (c) => {
    const gate = await authorize(c, createPublicKeyContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const keys = keyStore(c)
    const { label, scope, externalIdentity, workspaceIds } = c.req.valid('json')
    // The account comes from the KEY, never from the body. The reach defaults to the workspace this
    // request acts on (what every mint produced before keys could span workspaces) and can never
    // exceed the minting key's own.
    const reach = workspaceIds === undefined ? [gate.auth.workspaceId] : workspaceIds
    assertReachCovers(gate.auth.workspaceIds, reach, 'mint a key with that reach')
    await assertWorkspacesInAccount(c.get('container').workspaceService, gate.auth.accountId, reach)
    const { record, secret } = await keys.issue(
      {
        accountId: gate.auth.accountId,
        workspaceIds: reach,
        // No user minted this one. Attributing it to the human who minted the PARENT key would
        // be a guess dressed as provenance. The key is what acted, so the key is what is
        // recorded, and that is also what the revocation cascade follows.
        createdByUserId: null,
        createdByKeyId: gate.auth.keyId,
        // Whoever the caller says this key acts for, stored verbatim and never resolved. It is
        // NOT inherited from the provisioning key: a provisioner mints for many identities, so
        // defaulting to its own would attribute every minted key (and every run they start) to
        // the integration itself, which is exactly the answer this field exists to improve on.
        externalIdentity: externalIdentity ?? null,
        // No `actsAsUserId`, and there is no body field that could set one. Binding a key to a
        // user's PERSONAL subscription is a consent that only that person can give, in the app,
        // about their own credential; a provisioning key holds nobody's consent and inheriting
        // the parent's binding would hand every minted key an unlock its holder never agreed to.
        // An integration that needs one asks the person to mint it.
        actsAsUserId: null,
      },
      label,
      scope ?? DEFAULT_MINTED_SCOPE,
    )
    return c.json({ key: publicApiKeyToWire(record, gate.auth.workspaceId), secret }, 201)
  })

  buildHonoRoute(app, revokePublicKeyContract, async (c) => {
    const gate = await authorize(c, revokePublicKeyContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    // Scoped to the caller's account, and idempotent, so an unknown id is a 204 rather than a 404:
    // this surface must not become an oracle for which key ids exist. A key reaching workspaces
    // the caller cannot is refused, so a restricted admin key cannot retire a wider credential.
    //
    // Revoking the CALLING key is allowed on purpose: a provisioning credential retiring itself at
    // the end of a run is the case, and the request is already authorized by the time it lands.
    // That key is always an app-minted `admin` one, since revoking needs the rung this surface
    // cannot mint. Self-revocation is the PROVISIONER standing down (taking everything it
    // handed out with it), never a provisioned key handing itself back.
    const keys = keyStore(c)
    const target = await keys.getLive(gate.auth.accountId, c.req.valid('param').keyId)
    if (target) {
      assertReachCovers(gate.auth.workspaceIds, target.workspaceIds, 'revoke that key')
      await keys.revoke(gate.auth.accountId, target.id)
    }
    return c.body(null, 204)
  })

  return app
}
