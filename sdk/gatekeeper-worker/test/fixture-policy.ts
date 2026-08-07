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

import { DECISION_BINDINGS, type GatekeeperPolicy } from '../src/policy/index.js'

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

  tiers: {
    observer: {
      description: 'Read the board, runs, notifications and telemetry. Changes nothing.',
      keyScope: 'read',
      allow: '*',
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
  },

  grants: {
    'observer@example.com': 'observer',
    'operator@example.com': 'operator',
    'approver@example.com': 'approver',
  },
}
