import { Hono, type Context } from 'hono'
import type { SecretCipher } from '@cat-factory/kernel'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import {
  type SealedSecretSourceSpec,
  sealedSecretSourceSpec,
} from '../../secrets/sealedSecretSources.js'
import type {
  DelegatedSealRequest,
  DelegatedSealResponse,
  DelegatedUnsealRequest,
  DelegatedUnsealResponse,
} from '../../persistence/secretDelegation.js'

/**
 * The mothership-mode SECRET DELEGATION API: `POST /internal/secrets/unseal` and
 * `POST /internal/secrets/seal`.
 *
 * Product decision 3 of the mothership initiative splits the keys: a laptop seals its own
 * agent/model credentials under a LOCAL key, and the mothership's `ENCRYPTION_KEY` never reaches
 * it. That is what makes handing a sealed blob over the persistence RPC safe: only ciphertext
 * crosses. The cost is the mirror image: an org credential that a hosted teammate (or the
 * mothership's own engine) sealed is unreadable on the node, so provisioning an environment,
 * probing a release-health monitor and enriching an incident all failed there. Those surfaces were
 * parked off the allow-list rather than shipped broken.
 *
 * This pair closes that, and does it the way `notificationRelayController` closed external
 * delivery: **the wire names the ROW, never the ciphertext.** The node posts a source from a
 * CLOSED table (`SEALED_SECRET_SOURCES`) plus the row's identifiers; the mothership re-reads the
 * authoritative row from its OWN registry, checks the owning account against the node's token
 * scope, and decrypts under its own key. So this is not a decryption oracle: a compromised node
 * token can only ask for a value it could already have read had it held the key, in an account it
 * can already reach. An envelope-taking endpoint would have admitted ciphertext obtained anywhere
 * at all, which is precisely the design the notification relay rejected.
 *
 * The SEAL half exists because delegation has to be symmetric to be correct. A mothership-mode
 * node PROVISIONS environments, so it produces org secrets as well as consuming them; sealing
 * those under the local key would store a row the org can never open: the same silent split, one
 * write later, and invisible until a hosted teammate or the mothership's own teardown needed it.
 * Sealing takes no row read (encryption depends on the key, not the stored row), so it binds on
 * the workspace alone. It is not an encryption oracle in any useful sense either: the caller may
 * already write arbitrary bytes into that field through the allow-listed repository `upsert`.
 *
 * Security order mirrors every other `/internal/*` surface: the `machine` audience pin FIRST (so
 * availability is not probeable without a token), then the capability probe (503), then the
 * workspace → account scope binding, with a uniform 404 for anything out of scope, absent, or
 * holding no sealed value (no existence leak, and no distinguishing "wrong account" from "no such
 * row"). Every denial is audit-logged with the node + user ids; the PLAINTEXT is never logged, at
 * any level, and neither is the envelope.
 *
 * Mounted on BOTH facades so either a Node or a Cloudflare deployment can be a mothership. A
 * deployment that is not a mothership (no `repositories`) or that wired no cipher factory (no
 * `ENCRYPTION_KEY`, so nothing is sealed at all) serves a 503, after the auth check.
 */
export function secretDelegationController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/secrets/unseal', async (c) => {
    const gate = await openDelegation(c)
    if ('response' in gate) return gate.response
    const { log, scopeAccountIds, container, workspaces, cipherFor } = gate

    const body = await readJson<DelegatedUnsealRequest>(c)
    const spec = body ? sealedSecretSourceSpec(body.source) : undefined
    if (!body || !spec || typeof body.workspaceId !== 'string') {
      return validationError(c, 'source and workspaceId are required')
    }
    const key = readKey(body.key, spec)
    if (!key) {
      return validationError(c, `source '${body.source}' takes ${spec.keyArity} key argument(s)`)
    }

    const sourceLog = log.child({ source: body.source, workspaceId: body.workspaceId })
    const inScope = await accountInScope(workspaces, body.workspaceId, scopeAccountIds)
    if (!inScope) {
      sourceLog.warn('secret delegation: workspace out of scope')
      return notFound(c)
    }

    // Read the AUTHORITATIVE row through the source's declared point read. `workspaceId` is
    // PREPENDED by us rather than taken from the caller's `key`, so a node cannot address a row
    // outside the workspace it just proved it may reach even by naming one positionally.
    let envelope: unknown
    try {
      const row = await callRepositoryRead(container, spec, [body.workspaceId, ...key])
      envelope =
        row && typeof row === 'object' ? (row as Record<string, unknown>)[spec.field] : null
    } catch (error) {
      sourceLog.error('secret delegation: row read failed', { err: describe(error) })
      return internalError(c)
    }
    // An absent row and a row whose field holds nothing are the SAME uniform 404. The node read
    // the row to get here, so neither is an ordinary answer it should route around, and telling
    // them apart would confirm the row's existence to a caller that cannot reach it.
    if (typeof envelope !== 'string' || envelope.length === 0) {
      sourceLog.warn('secret delegation: no sealed value for the named row')
      return notFound(c)
    }

    let plaintext: string
    try {
      plaintext = await cipherFor(spec.info).decrypt(envelope)
    } catch (error) {
      // The mothership's OWN key failed on its OWN row: key drift (ADR 0026 D6.2), not a caller
      // fault. Reported as a 500 so the node retries rather than treating it as "nothing here",
      // and logged with the cause so the drift sweep's finding has a runtime counterpart.
      sourceLog.error('secret delegation: decrypt failed', { err: describe(error) })
      return internalError(c)
    }
    sourceLog.info('secret delegation: unsealed', { label: spec.label })
    return c.json({ ok: true, plaintext } satisfies DelegatedUnsealResponse)
  })

  app.post('/internal/secrets/seal', async (c) => {
    const gate = await openDelegation(c)
    if ('response' in gate) return gate.response
    const { log, scopeAccountIds, workspaces, cipherFor } = gate

    const body = await readJson<DelegatedSealRequest>(c)
    const spec = body ? sealedSecretSourceSpec(body.source) : undefined
    if (
      !body ||
      !spec ||
      typeof body.workspaceId !== 'string' ||
      typeof body.plaintext !== 'string'
    ) {
      return validationError(c, 'source, workspaceId and plaintext are required')
    }

    const sourceLog = log.child({ source: body.source, workspaceId: body.workspaceId })
    const inScope = await accountInScope(workspaces, body.workspaceId, scopeAccountIds)
    if (!inScope) {
      sourceLog.warn('secret delegation: workspace out of scope')
      return notFound(c)
    }

    let envelope: string
    try {
      envelope = await cipherFor(spec.info).encrypt(body.plaintext)
    } catch (error) {
      sourceLog.error('secret delegation: encrypt failed', { err: describe(error) })
      return internalError(c)
    }
    sourceLog.info('secret delegation: sealed', { label: spec.label })
    return c.json({ ok: true, envelope } satisfies DelegatedSealResponse)
  })

  return app
}

// ---------------------------------------------------------------------------
// Shared gate + helpers (both routes run the identical auth → capability → scope order)
// ---------------------------------------------------------------------------

type DelegationContext = Context<AppEnv>

/** The one repository read the scope binding needs, narrowed from the registry once, at the gate. */
interface WorkspaceAccountResolver {
  accountOf(workspaceId: string): Promise<string | null | undefined>
}

interface OpenDelegation {
  log: ReturnType<typeof logger.child>
  scopeAccountIds: string[]
  container: ServerContainer
  workspaces: WorkspaceAccountResolver
  cipherFor: (info: string) => SecretCipher
}

async function openDelegation(
  c: DelegationContext,
): Promise<OpenDelegation | { response: Response }> {
  const container = c.get('container')

  // Auth FIRST (before the capability probe) so a token-less caller cannot tell a mothership
  // with a cipher from one without.
  const payload = await verifyMachineRequest(c)
  if (!payload) {
    return {
      response: c.json(
        { ok: false, error: { code: 'forbidden', message: 'invalid machine token' } },
        403,
      ),
    }
  }

  const cipherFor = container.secretCipherFor
  const workspaceRepository = container.repositories?.workspaceRepository
  if (!cipherFor || typeof workspaceRepository?.accountOf !== 'function') {
    return {
      response: c.json(
        { ok: false, error: { code: 'internal', message: 'secret delegation not enabled' } },
        503,
      ),
    }
  }

  return {
    log: logger.child({
      scope: 'secretDelegation',
      nodeId: payload.nodeId,
      userId: payload.userId,
    }),
    scopeAccountIds: payload.scope.accountIds,
    container,
    workspaces: workspaceRepository as unknown as WorkspaceAccountResolver,
    cipherFor,
  }
}

/**
 * The `workspace` scope rule, verbatim from the persistence RPC: resolve the workspace's owning
 * account and require it in the token's scope. A read that throws fails CLOSED.
 */
async function accountInScope(
  workspaces: WorkspaceAccountResolver,
  workspaceId: string,
  scopeAccountIds: string[],
): Promise<boolean> {
  const accountId = await Promise.resolve(workspaces.accountOf(workspaceId)).catch(() => undefined)
  return !!accountId && scopeAccountIds.includes(accountId)
}

/** Invoke the source's declared point read on the mothership's own registry. */
async function callRepositoryRead(
  container: ServerContainer,
  spec: SealedSecretSourceSpec,
  args: (string | null)[],
): Promise<unknown> {
  const repositories = container.repositories as
    | Record<string, Record<string, unknown> | undefined>
    | undefined
  const repo = repositories?.[spec.repo]
  const method = repo?.[spec.method]
  if (typeof method !== 'function') {
    throw new Error(`${spec.repo}.${spec.method} is not wired on this mothership`)
  }
  return (method as (...a: unknown[]) => Promise<unknown>).apply(repo, args)
}

/**
 * The request's row identifiers, or undefined when the arity disagrees with the source's
 * declaration. Arity is checked rather than tolerated because the values are SPREAD into the
 * declared read: a short list silently reads a different row than the caller named, and a long
 * one passes an argument the port never declared.
 */
function readKey(raw: unknown, spec: SealedSecretSourceSpec): (string | null)[] | undefined {
  const key = raw === undefined ? [] : raw
  if (!Array.isArray(key) || key.length !== spec.keyArity) return undefined
  for (const value of key) {
    if (value !== null && typeof value !== 'string') return undefined
  }
  return key as (string | null)[]
}

async function readJson<T>(c: DelegationContext): Promise<T | undefined> {
  try {
    return (await c.req.json()) as T
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validationError(c: DelegationContext, message: string): Response {
  return c.json({ ok: false, error: { code: 'validation', message } }, 422)
}

function notFound(c: DelegationContext): Response {
  return c.json({ ok: false, error: { code: 'not_found', message: 'Not found' } }, 404)
}

function internalError(c: DelegationContext): Response {
  return c.json({ ok: false, error: { code: 'internal', message: 'Internal error' } }, 500)
}
