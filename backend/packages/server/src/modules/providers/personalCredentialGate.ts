import {
  ALL_SUBSCRIPTION_VENDORS,
  CredentialRequiredError,
  isAmbientNativeVendor,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import { PERSONAL_PASSWORD_HEADER } from '@cat-factory/contracts'
import type { Context } from 'hono'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import type { SessionPayload } from '../../auth/signing.js'

/**
 * WHOSE personal credential a run may unlock — the user id and nothing else.
 *
 * Narrower than `SessionPayload` on purpose. A browser session is one way to establish this, and
 * a public-API key its holder BOUND to themselves (`PublicApiKeyRecord.actsAsUserId`) is the
 * other; asking for a whole session would have forced the second caller to fabricate the login,
 * avatar and expiry of a person who is not signed in, and a fabricated session is a thing later
 * code reads as one. The gate never needed more than the id: ownership of the credential is what
 * it is deciding, and the PASSWORD, not this, is what proves the holder consented.
 */
export type PersonalCredentialOwner = Pick<SessionPayload, 'id'>

/**
 * Read the ambient personal password from the request header (see
 * `PERSONAL_PASSWORD_HEADER`). The client attaches it on the gated run calls the way it
 * attaches the bearer token, so it never lives in a request body. Absent ⇒ undefined.
 */
export function readPersonalPassword<E extends AppEnv>(c: Context<E>): string | undefined {
  return c.req.header(PERSONAL_PASSWORD_HEADER) || undefined
}

/**
 * A predicate over the vendors the run's user has their OWN personal subscription for.
 * Passed into the engine's vendor resolution so a DUAL-MODE individual model (GLM) gates
 * only a subscriber (a non-subscriber runs it on the Cloudflare base). Empty for an
 * unauthenticated/unconfigured caller — then only subscription-ONLY individual models
 * (Claude / Codex) gate.
 */
async function resolvePersonalVendorPredicate(
  container: ServerContainer,
  user: PersonalCredentialOwner | undefined,
): Promise<(vendor: SubscriptionVendor) => boolean> {
  const personal = container.personalSubscriptions
  if (!personal || !user) return () => false
  const owned = new Set((await personal.list(user.id)).map((s) => s.vendor))
  return (vendor) => owned.has(vendor)
}

/**
 * Re-mint a run's individual-usage activation(s) when a user interacts with it (resolve
 * decision / approve / request changes / resolve-exceeded). Runs BEFORE the engine advances
 * and dispatches the next step, so a fresh full-TTL activation is in place even if the prior
 * one lapsed. Unlike a silent best-effort refresh, this HARD-GATES exactly like start/retry:
 * a needed-but-absent/withheld password throws `428 credential_required` so the client
 * re-prompts EARLY (while the user is present at this interaction) instead of letting the run
 * break mid-pipeline on the next dispatch. No-op for a non-individual run (empty vendor set),
 * so the common path never prompts. See `getCachedPassword`'s 8h expiry buffer on the client.
 */
export async function activateForInteraction<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  executionId: string,
): Promise<void> {
  await refreshRunActivation(
    c.get('container'),
    workspaceId,
    executionId,
    c.get('user'),
    readPersonalPassword(c),
  )
}

/**
 * {@link activateForInteraction}'s context-free core, shared with the public-API decision surface
 * (which resolves its user from the key's binding rather than from a session).
 *
 * Skips the whole gate when the run already holds a FRESH activation for every vendor it needs, and
 * that short-circuit is what makes the interaction gate safe to mount in a shared preamble. Each
 * re-mint derives the password's key with 210k PBKDF2 iterations per vendor, so a headless driver
 * answering a run's parks one HTTP call at a time would pay that cost per call — seconds of blocked
 * event loop on Node, a CPU-limit kill on workerd. `hasFreshActivation` owns the threshold, because
 * only the service that mints the TTL can say what "fresh" means against it.
 *
 * The skip drops the password CHECK along with the derivation, and that is the honest reading rather
 * than a hole: the gate exists to tell a caller to supply the password while it can still act on
 * being told, and a run holding a credential that outlives its next dispatch has nothing to be told
 * about. Consent was given for THIS run, by this holder, within the same activation window.
 */
export async function refreshRunActivation(
  container: ServerContainer,
  workspaceId: string,
  executionId: string,
  user: PersonalCredentialOwner | undefined,
  password: string | undefined,
): Promise<void> {
  const vendors = await runVendorsNeedingUnlock(container, workspaceId, executionId, user)
  if (vendors.length === 0) return
  if (user && (await holdsFreshActivations(container, executionId, user.id, vendors))) return
  await gate(container, vendors, user, password).activate?.(executionId)
}

/** Whether every vendor the run needs already has an activation worth keeping. */
async function holdsFreshActivations(
  container: ServerContainer,
  executionId: string,
  userId: string,
  vendors: SubscriptionVendor[],
): Promise<boolean> {
  const personal = container.personalSubscriptions
  if (!personal) return false
  const fresh = await Promise.all(
    vendors.map((vendor) => personal.hasFreshActivation(executionId, userId, vendor)),
  )
  return fresh.every(Boolean)
}

// Shared gate for the individual-usage restricted mode (Claude / GLM / ChatGPT-Codex).
// When a run resolves to one or more such models, only the signed-in initiator may run
// it, using THEIR OWN stored personal subscription(s), unlocked with their password.
// This resolves the initiator id + (when needed) an `activate` closure the execution
// engine calls to mint the per-run credential activation(s) before dispatch. A run that
// touches no individual-usage vendor needs neither.

export interface PersonalCredentialGate {
  /** Recorded on the run (individual-usage credential ownership). */
  initiatedBy: string | null
  /**
   * Mints the per-run activation(s); passed to `executionService.start`/`retry` so it
   * runs with the new run id before dispatch. Undefined when the run needs no personal
   * credential.
   */
  activate?: (executionId: string) => Promise<void>
}

/**
 * Build the gate for the set of individual-usage vendors a run will use (empty ⇒ no
 * personal credential needed). The same password unlocks every vendor's activation: the
 * client caches one password and rides it along, and a per-vendor failure (wrong/missing
 * password, no subscription) surfaces as a `428 credential_required` the client re-prompts
 * on. Vendors are activated in order, so the first one that can't be unlocked is reported.
 */
function gate(
  container: ServerContainer,
  vendors: SubscriptionVendor[],
  user: PersonalCredentialOwner | undefined,
  password: string | undefined,
): PersonalCredentialGate {
  if (vendors.length === 0) return { initiatedBy: user?.id ?? null }
  // The vendor named in the up-front errors (before any activation is attempted).
  const first = vendors[0]!
  if (!user) {
    throw new CredentialRequiredError(
      `Sign in to run a ${first} model with your personal subscription.`,
      { vendor: first, reason: 'no_subscription' },
    )
  }
  const personal = container.personalSubscriptions
  if (!personal) {
    throw new CredentialRequiredError(
      `Personal ${first} subscriptions are not configured on this deployment.`,
      { vendor: first, reason: 'no_subscription' },
    )
  }
  if (!password) {
    // The credential exists (or not) — either way the unlock needs the password; the
    // client re-prompts on this reason and retries with it.
    throw new CredentialRequiredError(`Enter your personal password to run this ${first} model.`, {
      vendor: first,
      reason: 'password_required',
    })
  }
  return {
    initiatedBy: user.id,
    activate: async (executionId) => {
      for (const vendor of vendors) {
        await personal.activateForRun(executionId, user.id, vendor, password)
      }
    },
  }
}

/**
 * The individual-usage vendors that NATIVE local execution serves with the developer's
 * own ambient CLI login — these need no managed credential, so they are dropped from the
 * gate's vendor set. Decided by the shared {@link isAmbientNativeVendor} predicate so the
 * gate can never drift from `ContainerAgentExecutor`'s ambient decision (a non-native
 * vendor reusing the `claude-code` harness still leases and so must still gate).
 */
function ambientVendors(container: ServerContainer): Set<SubscriptionVendor> {
  const allow = container.config.nativeAmbientAuth
  return new Set(ALL_SUBSCRIPTION_VENDORS.filter((v) => isAmbientNativeVendor(allow, v)))
}

/** Gate for STARTING a run on a block with a given pipeline. */
export async function personalGateForBlock(
  container: ServerContainer,
  workspaceId: string,
  blockId: string,
  pipelineId: string,
  user: PersonalCredentialOwner | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  const vendors = await container.executionService.individualVendorsForBlock(
    workspaceId,
    blockId,
    pipelineId,
    await resolvePersonalVendorPredicate(container, user),
  )
  // Native local execution serves its OWN ambient vendors (Claude/Codex) with the
  // developer's CLI login — no managed credential — so drop just those; a non-native
  // vendor reusing the claude-code harness still leases and so still gates.
  const ambient = ambientVendors(container)
  return gate(
    container,
    vendors.filter((v) => !ambient.has(v)),
    user,
    password,
  )
}

/** Gate for starting a SINGLE-KIND run (the "Map service" action, the wizard's deep analysis). */
export async function personalGateForAgentKind(
  container: ServerContainer,
  workspaceId: string,
  blockId: string,
  agentKind: string,
  user: PersonalCredentialOwner | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  const vendors = await container.executionService.individualVendorsForAgentKind(
    workspaceId,
    blockId,
    agentKind,
    await resolvePersonalVendorPredicate(container, user),
  )
  // See personalGateForBlock: drop only the vendors native mode serves ambiently.
  const ambient = ambientVendors(container)
  return gate(
    container,
    vendors.filter((v) => !ambient.has(v)),
    user,
    password,
  )
}

/** Gate for RETRYING a failed run. */
export async function personalGateForRun(
  container: ServerContainer,
  workspaceId: string,
  executionId: string,
  user: PersonalCredentialOwner | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  return gate(
    container,
    await runVendorsNeedingUnlock(container, workspaceId, executionId, user),
    user,
    password,
  )
}

/**
 * The individual-usage vendors a run's remaining steps need a MANAGED unlock for: what the engine
 * resolves off the stored steps, less the ones native mode serves with the developer's own ambient
 * CLI login (see {@link ambientVendors}).
 *
 * Extracted because two callers ask the same question and must not answer it differently: the retry
 * gate, which mints a full-TTL activation for a fresh attempt, and {@link refreshRunActivation},
 * which needs the set BEFORE deciding whether re-minting is necessary at all.
 */
async function runVendorsNeedingUnlock(
  container: ServerContainer,
  workspaceId: string,
  executionId: string,
  user: PersonalCredentialOwner | undefined,
): Promise<SubscriptionVendor[]> {
  const vendors = await container.executionService.individualVendorsForRun(
    workspaceId,
    executionId,
    await resolvePersonalVendorPredicate(container, user),
  )
  const ambient = ambientVendors(container)
  return vendors.filter((v) => !ambient.has(v))
}
