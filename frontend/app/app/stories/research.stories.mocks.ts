import type {
  FindingsStoragePolicyView,
  ResearchProjectView,
  ResearchRevisionEntry,
} from '@cat-factory/contracts'

// A research project as the findings reader reads it: a vendor definition pinned at version 2,
// two revisions (one offloaded to content storage), answers with evidence, an open question, and
// a credential the board has not stored. Shared by the research stories.

export const researchRevisions: ResearchRevisionEntry[] = [
  {
    id: 'frv_task_1',
    projectId: 'prj_vendor',
    taskId: 'task_1',
    seq: 1,
    mode: 'initial',
    definitionKey: 'acme:vendor',
    definitionVersion: 2,
    createdAt: Date.UTC(2026, 9, 2, 9, 30),
    storage: { placement: 'inline', bytes: 6_240, readable: true },
  },
  {
    id: 'frv_task_2',
    projectId: 'prj_vendor',
    taskId: 'task_2',
    seq: 2,
    mode: 'clarify',
    definitionKey: 'acme:vendor',
    definitionVersion: 2,
    createdAt: Date.UTC(2026, 9, 9, 14, 5),
    storage: { placement: 'offloaded', bytes: 412_000, readable: true },
  },
]

export const researchView: ResearchProjectView = {
  projectId: 'prj_vendor',
  pin: {
    definitionKey: 'acme:vendor',
    definitionVersion: 2,
    definitionHash: 'f00d',
    inputs: { region: 'eu' },
  },
  definition: {
    key: 'acme:vendor',
    version: 2,
    title: 'Content platform integration',
    brief: 'How the content platform authenticates, what its API exposes, and its rate limits.',
    topics: [
      {
        id: 'auth',
        title: 'Authentication',
        questions: [
          { id: 'scheme', question: 'Which authentication scheme does the API use?' },
          { id: 'scopes', question: 'Which scopes does an integration need?' },
        ],
      },
      {
        id: 'limits',
        title: 'Rate limits',
        questions: [{ id: 'quota', question: 'What is the request quota per tenant?' }],
      },
    ],
    credentials: [
      {
        key: 'VENDOR_LOGIN',
        kind: 'login',
        label: 'Vendor admin login',
        onboarding: {
          url: 'https://app.vendor.example/settings/users',
          instructions: 'Create a user with the Integrator role under Settings, Users.',
        },
        requiredAtStart: false,
      },
    ],
    targets: [{ baseUrl: 'https://app.vendor.example', surface: 'ui' }],
    inputs: [],
    promptAdditions: {},
  },
  definitionChanged: false,
  summary: 'The API uses OAuth client credentials; scopes are documented, quotas are not.',
  latestRevisionId: 'frv_task_2',
  findings: [
    {
      finding: {
        questionId: 'scheme',
        status: 'answered',
        answer: 'OAuth 2.0 **client credentials**, with a token valid for one hour.',
        confidence: 'high',
        evidence: [
          { kind: 'url', url: 'https://docs.vendor.example/auth' },
          { kind: 'http-exchange', ref: 'ex_3' },
        ],
        caveats: [],
      },
      revisionId: 'frv_task_1',
      seq: 1,
      notes: [],
    },
    {
      finding: {
        questionId: 'scopes',
        status: 'blocked',
        answer: '',
        confidence: 'low',
        evidence: [],
        caveats: ['The scope list is only shown to signed-in administrators.'],
        blockedOn: { credentialKey: 'VENDOR_LOGIN' },
      },
      revisionId: 'frv_task_2',
      seq: 2,
      notes: [],
    },
  ],
  learnings: [
    {
      title: 'A sandbox tenant exists',
      detail: 'Each account gets one sandbox tenant with production limits.',
      revisionId: 'frv_task_1',
    },
  ],
  adhocQuestions: [],
  coverage: {
    total: { answered: 1, partial: 0, unanswered: 1, blocked: 1 },
    byTopic: [
      { topicId: 'auth', counts: { answered: 1, partial: 0, unanswered: 0, blocked: 1 } },
      { topicId: 'limits', counts: { answered: 0, partial: 0, unanswered: 1, blocked: 0 } },
    ],
    adhoc: { answered: 0, partial: 0, unanswered: 0, blocked: 0 },
    retiredQuestionIds: [],
  },
  revisions: researchRevisions,
  credentials: [
    {
      key: 'VENDOR_LOGIN',
      kind: 'login',
      label: 'Vendor admin login',
      onboarding: {
        url: 'https://app.vendor.example/settings/users',
        instructions: 'Create a user with the Integrator role under Settings, Users.',
      },
      requiredAtStart: false,
      status: 'missing',
    },
  ],
}

export const researchPolicy: FindingsStoragePolicyView = {
  account: { inlineMaxBytes: 262_144 },
  workspace: null,
  project: { offload: 'enabled' },
  effective: { inlineMaxBytes: 262_144, offload: 'enabled' },
}
