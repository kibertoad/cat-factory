// This suite's own reads and writes over `/api/v1`, and the two clients wired to its configuration.
//
// The kit owns the CLIENTS (a fast-refusing one for anything that runs before a pass has spent
// something, a retrying one for a scenario body) and the descriptions a long wait prints. What is
// here is what only this suite knows: that its personal-subscription unlock is the header seam, that
// every task it files pins its model preset, and what is wrong with a key pointed at another board.

import {
  briefFields,
  createClient as createKitClient,
  createPassClient as createKitPassClient,
} from '@cat-factory/acceptance-kit'
import type { CatFactoryClient } from '@cat-factory/sdk'
import type {
  CreatePublicTask,
  PublicDecisionList,
  PublicIdentity,
  PublicRun,
  PublicService,
  PublicTask,
} from '@cat-factory/sdk'
import type { AcceptanceConfig } from './config.ts'
import type { PersonalUnlock } from '@cat-factory/acceptance-kit/console-credential'
import { type PinnedPreset, pinnedModel } from './presets.ts'

export type { PublicDecisionList, PublicIdentity, PublicRun, PublicService }

/**
 * The client for anything that runs BEFORE a pass has spent something: preflight, and `reset`.
 *
 * Takes the two fields it addresses rather than the whole config, which is what lets a command
 * holding only the BOARD half (`reset`) build its client through this door rather than stand up a
 * second one beside it.
 *
 * The password rides the kit's `headers` seam rather than a snapshot at construction, and that is
 * forced by what the password IS: it is not known until a call has already been refused for want of
 * it, and must then travel on EVERY later request (each answered decision re-mints the run's
 * activation server-side). Absent unlock ⇒ the plain client, byte for byte: a workspace on a
 * provider API key sends no such header and is never asked for a password.
 */
export function createClient(
  config: Pick<AcceptanceConfig, 'baseUrl' | 'apiKey'>,
  unlock?: PersonalUnlock,
): CatFactoryClient {
  return createKitClient(config, headerSeam(unlock))
}

/** The client a SCENARIO BODY drives, where a deployment restart costs an afternoon of agent work. */
export function createPassClient(
  config: Pick<AcceptanceConfig, 'baseUrl' | 'apiKey'>,
  unlock?: PersonalUnlock,
): CatFactoryClient {
  return createKitPassClient(config, headerSeam(unlock))
}

function headerSeam(unlock: PersonalUnlock | undefined) {
  return unlock ? { headers: () => unlock.headers() } : {}
}

/**
 * The pinned preset with the catalog row its base model resolves to, or `null` when either is gone.
 *
 * The two list reads that answer "what does this pass actually run on", in ONE place, because the
 * question is asked twice: the up-front unlock asks it before the first scenario, and the
 * `model-preset` prerequisite asks a WIDER version of it (it needs the whole library to name the
 * alternatives in its refusal). The round trips are therefore not duplication to remove; the join
 * is, and it lives here beside the client rather than in `presets.ts`, which stays pure.
 *
 * Deliberately not `ConfigureClient`'s pair of reads: that port narrows the catalog row to the
 * fields its menu branches on, and the fields the unlock prompt NAMES to an operator (`label`,
 * `provider`) are exactly the ones it drops. Widening a documented port for a second consumer's
 * prose is the wrong direction; both read the same endpoint through the same SDK.
 */
export async function readPinnedPreset(
  client: CatFactoryClient,
  presetId: string,
): Promise<PinnedPreset | null> {
  const [{ presets }, { models }] = await Promise.all([
    client.modelPresets.list(),
    client.models.list(),
  ])
  return pinnedModel(presets, models, presetId)
}

/**
 * File a task with the pass's model preset PINNED, and its brief wherever the brief FITS. The
 * suite's only door onto task creation.
 *
 * One helper rather than the fields repeated at each `client.tasks.create` call, because the value
 * of pinning is that EVERY run of a pass runs on the model the pass names, and a site that forgot
 * the field would silently resolve the workspace default instead: a result that reads exactly like
 * the others and was produced by a different model. There are five such sites (two scaffolds, two
 * feature halves, one bug report) and nothing would fail if one of them drifted.
 *
 * The brief goes through the kit's `briefFields`, which is the SIZE half of the same argument.
 * `description` is capped at 2,000 characters and both scaffold briefs are past it (2,507 and
 * 2,697), so scenario 01 filed its first task into a `422` after the operator had created two
 * repositories and wired a workspace. Over the cap the brief becomes an attached document, which is
 * this surface's own documented path for spec-sized input; under it nothing changes at all, which is
 * why every site routes through here rather than the two that needed it.
 *
 * Only the model preset is pinned. The RISK POLICY is deliberately left to resolve, because
 * `auto-merge-policy` grades the workspace default and a pin here would make that gate a check on
 * a policy no run of this suite uses.
 */
export function filePinnedTask(
  client: CatFactoryClient,
  config: AcceptanceConfig,
  serviceId: string,
  task: Omit<CreatePublicTask, 'modelPresetId'>,
): Promise<PublicTask> {
  return client.tasks.create(serviceId, {
    ...task,
    // The task's OWN title names the attachment, so the agent reads a document called "Stand up the
    // catalog API service" rather than a generic "Brief" beside whatever else the task carries.
    ...(task.description === undefined
      ? {}
      : briefFields({ brief: task.description, title: task.title })),
    modelPresetId: config.modelPresetId,
  })
}

/**
 * What is wrong with the key, or null. Checked before anything is created.
 *
 * Two failures this catches, both of which would otherwise appear much later wearing a
 * misleading face: a key bound to a DIFFERENT workspace than `ACCEPTANCE_WORKSPACE_ID` (the pass
 * then creates its repositories and services on that workspace's board while every assertion
 * about THIS one answers 404, which reads as a broken deployment), and a key below `admin`
 * (scenario 01 creates services and scenario 03 answers a human gate, so a `write` key gets a third of
 * the way and refuses).
 *
 * A returned value rather than a throw, because the prerequisite gate reports it as one verdict
 * beside nine others: refusing out of the first probe is what collecting every problem exists to
 * avoid.
 *
 * The `code` is a CLOSED vocabulary rather than decoration on the prose: the two failures have
 * different fixes (one is an environment variable, the other is a token that must be minted
 * again), so `prerequisites.ts` keys its instructions off it and gains a compile error rather
 * than a paraphrase when a third failure is added here.
 */
export type KeyProblem = {
  code: 'workspace-mismatch' | 'insufficient-scope'
  problem: string
}

export function describeKeyProblem(
  identity: PublicIdentity,
  workspaceId: string,
): KeyProblem | null {
  if (identity.workspaceId !== workspaceId) {
    return {
      code: 'workspace-mismatch',
      problem:
        `CAT_FACTORY_API_KEY is bound to workspace ${identity.workspaceId}, but ` +
        `ACCEPTANCE_WORKSPACE_ID is ${workspaceId}. The public API is workspace-scoped and the ` +
        `app-API setup calls are addressed by id, so the two must name the same board.`,
    }
  }
  // The ladder is INCLUSIVE, so this is the rung test the contract asks for, not an equality
  // check: `admin` is the top and is what scenario 01 (create a service) and scenario 03 (answer the
  // clarity gate, which needs `decide`) between them require.
  if (identity.scope !== 'admin') {
    return {
      code: 'insufficient-scope',
      problem:
        `CAT_FACTORY_API_KEY is scoped '${identity.scope}'. This suite creates services (admin) ` +
        `and answers a parked human gate (decide), so it needs an 'admin' key.`,
    }
  }
  return null
}
