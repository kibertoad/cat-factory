// The policy the suite's Worker is built with.
//
// A FIXTURE, not the shipped example: `deploy/gatekeeper/src/policy.config.ts` is what an operator
// copies and edits, and pinning this package's behaviour to that file would make every edit an
// operator is invited to make a failure here. What the tiers below exist for is to exercise the
// machinery: a wildcard read tier WITH a deny list (so `not_in_policy` and `denied_by_policy` are
// distinguishable), a named-grant write tier (so `above_key_scope` has something to report), and a
// `decide` tier deriving its decision half from the answerer table (so a park the platform adds is
// answerable here without anyone transcribing a list).
//
// The tier names and the actor ids match the shipped example on purpose: they are what the specs
// read, and a reader comparing the two should see one shape rather than two vocabularies.

import {
  DECISION_BINDINGS,
  TELEMETRY_BINDINGS,
  type GatekeeperPolicy,
} from '../src/policy/index.js'

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

export const FIXTURE_POLICY: GatekeeperPolicy = {
  defaultTier: null,

  // The Cloudflare OS door's own default, exercised by `os.spec.ts`. It is a FOURTH tier rather
  // than one of the three above because the two doors name callers differently: the three above are
  // resolved from `grants` by an identity the OS asserts, and an auto-provisioned account has no
  // such identity to be granted by. `workspace` is the write tier plus one telemetry read, which is
  // the smallest set that can tell the governed paths apart (a plain read, an unshareable read, a
  // non-destructive write and a destructive one).
  autoProvisionedTier: 'workspace',

  tiers: {
    observer: {
      description: 'Read the board, runs, notifications and telemetry. Changes nothing.',
      keyScope: 'read',
      allow: '*',
      deny: [...TELEMETRY_BINDINGS],
    },

    operator: {
      description: 'File and run work: create, update, start, retry and stop tasks.',
      keyScope: 'write',
      allow: DELIVERY_LOOP,
    },

    approver: {
      description: 'Everything an operator can do, plus answering a run’s parked decisions.',
      keyScope: 'decide',
      allow: [...DELIVERY_LOOP, 'notifications_dismiss', ...DECISION_BINDINGS],
    },

    workspace: {
      description:
        'What a Cloudflare OS workspace agent gets: the delivery loop, a run’s parked decisions, ' +
        'and one look at its model calls.',
      keyScope: 'write',
      // `decisions_list` is here because `approvals_inspect` is a RESERVED method every capability
      // carries and it reads the run's live decision list through the same `invoke`: a tier that
      // does not grant it ships an inbox method that refuses on the operation it was built on.
      allow: [...DELIVERY_LOOP, 'decisions_list', 'debug_list_llm_calls'],
    },
  },

  grants: {
    'observer@example.com': 'observer',
    'operator@example.com': 'operator',
    'approver@example.com': 'approver',
  },
}
