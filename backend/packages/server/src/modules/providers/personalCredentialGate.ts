import { CredentialRequiredError, type SubscriptionVendor } from '@cat-factory/kernel'
import { PERSONAL_PASSWORD_HEADER } from '@cat-factory/contracts'
import type { Context } from 'hono'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import type { SessionPayload } from '../../auth/signing.js'

/**
 * Read the ambient personal password from the request header (see
 * `PERSONAL_PASSWORD_HEADER`). The client attaches it on the gated run calls the way it
 * attaches the bearer token, so it never lives in a request body. Absent ⇒ undefined.
 */
export function readPersonalPassword(c: Context<AppEnv>): string | undefined {
  return c.req.header(PERSONAL_PASSWORD_HEADER) || undefined
}

/**
 * Best-effort, transparent re-mint of a run's individual-usage activation(s) when a user
 * interacts with it (resolve decision / approve / request changes). Runs BEFORE the engine
 * advances and dispatches the next step, so a freshly-minted activation is in place even if
 * the previous one lapsed under its short TTL — keeping an actively-tended run alive without
 * re-prompting. Driven off the cached password on the header; a wrong/absent one is ignored
 * (the next dispatch then 428s and the client re-prompts on retry). Never throws, and skips
 * entirely for non-individual runs (no password work on the common path).
 */
export async function remintActivations(
  c: Context<AppEnv>,
  workspaceId: string,
  executionId: string,
): Promise<void> {
  const container = c.get('container')
  const personal = container.personalSubscriptions
  const user = c.get('user')
  if (!personal || !user) return
  try {
    const vendors = await container.executionService.individualVendorsForRun(
      workspaceId,
      executionId,
    )
    if (vendors.length === 0) return
    const password = readPersonalPassword(c)
    if (password) {
      // Re-mint from the password — robust even when the prior activation already expired.
      for (const vendor of vendors) {
        await personal.activateForRun(executionId, user.id, vendor, password)
      }
    } else {
      // No password on hand — just extend any still-live activation (no-op if expired).
      await personal.refreshActivations(executionId, user.id)
    }
  } catch {
    // Best-effort: a lapsed run surfaces 428 at the next dispatch, which the client retries.
  }
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
  user: SessionPayload | undefined,
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

/** Gate for STARTING a run on a block with a given pipeline. */
export async function personalGateForBlock(
  container: ServerContainer,
  workspaceId: string,
  blockId: string,
  pipelineId: string,
  user: SessionPayload | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  const vendors = await container.executionService.individualVendorsForBlock(
    workspaceId,
    blockId,
    pipelineId,
  )
  return gate(container, vendors, user, password)
}

/** Gate for RETRYING a failed run. */
export async function personalGateForRun(
  container: ServerContainer,
  workspaceId: string,
  executionId: string,
  user: SessionPayload | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  const vendors = await container.executionService.individualVendorsForRun(workspaceId, executionId)
  return gate(container, vendors, user, password)
}
