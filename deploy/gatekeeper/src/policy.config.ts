// THE FILE AN OPERATOR EDITS.
//
// The machinery lives in `@cat-factory/gatekeeper-worker`; this is the deployment's actual
// governance decision, kept in source rather than in a var because it is the thing a reviewer
// should see in a diff. Three tiers are shipped as a starting point. They are examples, not
// defaults you should keep: the names, the grants and above all `defaultTier` describe ONE way of
// pairing an OS workspace with a cat-factory workspace, and yours will differ.
//
// Two properties are worth preserving whatever you change:
//
//   - Grant by NAME, not by `'*'`, wherever the tier can mutate. `'*'` is honest for the observer
//     tier (every read the key can make is a read) and dangerous above it: a deployment that adds
//     an operation ships it to every `'*'` tier on upgrade, with nobody having decided to.
//   - Keep `keyScope` as low as the grants allow. It is the scope of the key MINTED FOR EACH
//     ACTOR, so it is also the blast radius of that actor's credential if the OS side is
//     compromised. `compilePolicy` refuses a grant above it rather than letting the two drift.

// The `/policy` entry point rather than the package root: it carries the same vocabulary without
// pulling in the Worker runtime, so this file (and the test beside it) loads anywhere.
import {
  DECISION_BINDINGS,
  TELEMETRY_BINDINGS,
  type GatekeeperPolicy,
} from '@cat-factory/gatekeeper-worker/policy'

/**
 * The everyday delivery loop: file work, start it, watch it, stop it.
 *
 * Named once and reused by both tiers below, because `approver` is deliberately "everything an
 * operator can do, PLUS the parked decisions". Two hand-kept copies of one list is how the two
 * silently diverge on the next operation somebody adds to only one of them.
 */
const DELIVERY_LOOP = [
  'services_list',
  'pipelines_list',
  'task_types_list',
  'tasks_list_by_service',
  'tasks_get',
  'tasks_get_run',
  'tasks_create',
  'tasks_update',
  'tasks_start',
  'tasks_retry',
  'tasks_stop',
  'jobs_list',
  'jobs_get',
  'jobs_create',
  'jobs_cancel',
  'notifications_list',
  'usage_get',
  'me_get',
] as const

export const POLICY: GatekeeperPolicy = {
  // No implicit access. An OS user with no grant below gets `unknown_actor` rather than a
  // capability, so adding someone is a deliberate edit to this file. Name a tier here only if
  // your OS deployment's own membership is the access decision you want to rely on.
  defaultTier: null,

  tiers: {
    // Read-only oversight: what a status Gadget needs to render a board and a run, and nothing
    // that spends money or changes state. `'*'` is safe here precisely because the key cannot
    // mutate: a future read operation joining this tier is a new thing to LOOK at.
    observer: {
      description: 'Read the board, runs, notifications and telemetry. Changes nothing.',
      keyScope: 'read',
      allow: '*',
      // Half the debug surface answers with model prompts, captured command output and search
      // text. All of it is within a `read` key's floor, so nothing but this list stops an OS
      // workspace agent paging through it. The run OVERVIEWS (`debug_get_run`, `debug_list_runs`)
      // stay granted deliberately: they read no telemetry sink, so they carry lifecycle and
      // failure shape and no body.
      //
      // `TELEMETRY_BINDINGS`, not a transcribed list. Every one of those names is a read, so
      // `allow: '*'` above grants it and only this line takes it back; a hand-typed copy stops
      // covering the surface the day an operation joins it, and nothing fails when it does. That
      // is not hypothetical: the LLM export shipped granted here while every sibling read of the
      // same sink was denied.
      deny: [...TELEMETRY_BINDINGS],
    },

    // The everyday delivery loop: file work, start it, watch it, stop it. It cannot answer a
    // parked decision (that is `approver`) and it cannot delete a task.
    operator: {
      description: 'File and run work: create, update, start, retry and stop tasks.',
      keyScope: 'write',
      allow: DELIVERY_LOOP,
    },

    // Answers the runs the platform parks on a human. `decide` is the highest scope this
    // Gatekeeper hands out, and note what is still NOT granted at it: `notifications_act`, which
    // can perform a real merge, and `tasks_delete`. Those stay with a person in the cat-factory
    // app, where the merge policy knows who they are (ADR 0037/0039).
    //
    // The decision half is `DECISION_BINDINGS`, not a hand-typed list. A run can park on THIRTEEN
    // different things and each takes its own operations, so a transcribed list is a tier that
    // answers the parks somebody remembered and reports the rest as stale, which is exactly what
    // the first cut of this file did. Deriving it from the answerer table means a tier that can
    // answer a park is a tier that was granted what answering it takes, by construction.
    approver: {
      description: 'Everything an operator can do, plus answering a run’s parked decisions.',
      keyScope: 'decide',
      allow: [...DELIVERY_LOOP, 'notifications_dismiss', ...DECISION_BINDINGS],
    },
  },

  // OS user identity to tier. What the key is on depends on what your OS deployment
  // authenticates and passes to `connect()`; an email is the common case, and it is also what
  // rides `externalIdentity` onto every key this Gatekeeper mints, so a run traces back to a
  // person without cat-factory ever holding your directory.
  grants: {
    'observer@example.com': 'observer',
    'operator@example.com': 'operator',
    'approver@example.com': 'approver',
  },
}
