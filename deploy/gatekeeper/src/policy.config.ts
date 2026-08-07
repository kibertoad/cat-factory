// THE FILE AN OPERATOR EDITS.
//
// Everything else in this package is machinery; this is the deployment's actual governance
// decision, kept in source rather than in a var because it is the thing a reviewer should see in
// a diff. Three tiers are shipped as a starting point. They are examples, not defaults you should
// keep: the names, the grants and above all `defaultTier` describe ONE way of pairing an OS
// workspace with a cat-factory workspace, and yours will differ.
//
// Two properties are worth preserving whatever you change:
//
//   - Grant by NAME, not by `'*'`, wherever the tier can mutate. `'*'` is honest for the observer
//     tier (every read the key can make is a read) and dangerous above it: a deployment that adds
//     an operation ships it to every `'*'` tier on upgrade, with nobody having decided to.
//   - Keep `keyScope` as low as the grants allow. It is the scope of the key MINTED FOR EACH
//     ACTOR, so it is also the blast radius of that actor's credential if the OS side is
//     compromised. `compilePolicy` refuses a grant above it rather than letting the two drift.

import type { GatekeeperPolicy } from './policy'

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
      // stay granted deliberately: they carry lifecycle and failure shape, which is what a status
      // Gadget is for, and no body.
      deny: [
        'debug_get_agent_context',
        'debug_get_llm_call',
        'debug_list_agent_context',
        'debug_list_llm_calls',
        'debug_list_logs',
        'debug_list_search_queries',
        'debug_list_tool_calls',
      ],
    },

    // The everyday delivery loop: file work, start it, watch it, stop it. It cannot answer a
    // parked decision (that is `approver`) and it cannot delete a task.
    operator: {
      description: 'File and run work: create, update, start, retry and stop tasks.',
      keyScope: 'write',
      allow: [
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
      ],
    },

    // Answers the runs the platform parks on a human. `decide` is the highest scope this
    // Gatekeeper hands out, and note what is still NOT granted at it: `notifications_act`, which
    // can perform a real merge, and `tasks_delete`. Those stay with a person in the cat-factory
    // app, where the merge policy knows who they are (ADR 0037/0039).
    approver: {
      description: 'Everything an operator can do, plus answering a run’s parked decisions.',
      keyScope: 'decide',
      allow: [
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
        'notifications_dismiss',
        'usage_get',
        'me_get',
        'decisions_list',
        'decisions_approve_step',
        'decisions_request_step_changes',
        'decisions_reject_step',
        'decisions_resolve_step_exceeded',
        'decisions_answer_agent_decision',
        'decisions_choose_fork',
        'decisions_resolve_input_gate',
        'decisions_resolve_judge',
        'decisions_reply_to_finding',
        'decisions_set_finding_status',
        'decisions_incorporate',
        'decisions_re_review',
        'decisions_proceed',
        'decisions_resolve_exceeded',
      ],
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
