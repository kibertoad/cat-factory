import { CredentialRequiredError, type SubscriptionVendor } from '@cat-factory/kernel'
import type { SessionPayload } from '../../auth/signing.js'
import type { ServerContainer } from '../../http/env.js'

// Shared gate for the individual-usage restricted mode (Claude). When a run's block
// resolves to such a model, only the signed-in initiator may run it, using THEIR OWN
// stored personal subscription, unlocked with their password. This resolves the
// initiator id + (when needed) an `activate` closure the execution engine calls to mint
// the per-run credential activation before dispatch. A non-individual run needs neither.

export interface PersonalCredentialGate {
  /** Recorded on the run (individual-usage credential ownership). */
  initiatedBy: number | null
  /**
   * Mints the per-run activation; passed to `executionService.start`/`retry` so it runs
   * with the new run id before dispatch. Undefined for non-individual runs.
   */
  activate?: (executionId: string) => Promise<void>
}

/** Build the gate for a given vendor (null ⇒ no personal credential needed). */
function gate(
  container: ServerContainer,
  vendor: SubscriptionVendor | null,
  user: SessionPayload | undefined,
  password: string | undefined,
): PersonalCredentialGate {
  if (!vendor) return { initiatedBy: user?.id ?? null }
  if (!user) {
    throw new CredentialRequiredError(
      `Sign in to run a ${vendor} model with your personal subscription.`,
      { vendor, reason: 'no_subscription' },
    )
  }
  const personal = container.personalSubscriptions
  if (!personal) {
    throw new CredentialRequiredError(
      `Personal ${vendor} subscriptions are not configured on this deployment.`,
      { vendor, reason: 'no_subscription' },
    )
  }
  if (!password) {
    // The credential exists (or not) — either way the unlock needs the password; the
    // client re-prompts on this reason and retries with it.
    throw new CredentialRequiredError(
      `Enter your personal password to run this ${vendor} model.`,
      { vendor, reason: 'password_required' },
    )
  }
  return {
    initiatedBy: user.id,
    activate: (executionId) => personal.activateForRun(executionId, user.id, vendor, password),
  }
}

/** Gate for STARTING a run on a block. */
export async function personalGateForBlock(
  container: ServerContainer,
  workspaceId: string,
  blockId: string,
  user: SessionPayload | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  const vendor = await container.executionService.individualVendorForBlock(workspaceId, blockId)
  return gate(container, vendor, user, password)
}

/** Gate for RETRYING a failed run. */
export async function personalGateForRun(
  container: ServerContainer,
  workspaceId: string,
  executionId: string,
  user: SessionPayload | undefined,
  password: string | undefined,
): Promise<PersonalCredentialGate> {
  const vendor = await container.executionService.individualVendorForRun(workspaceId, executionId)
  return gate(container, vendor, user, password)
}
