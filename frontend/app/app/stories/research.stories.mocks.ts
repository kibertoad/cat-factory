import type {
  OutcomeStoragePolicyView,
  ProjectBoardView,
  ProjectOutcomeEntry,
  ResearchProjectView,
} from '@cat-factory/contracts'

// A research project as its board view reads it: a vendor definition pinned at version 2, two
// outcomes (one offloaded to content storage), answers with evidence, an open question, and a
// credential the board has not stored. Shared by the project view stories.

export const researchOutcomes: ProjectOutcomeEntry[] = [
  {
    id: 'pout_task_1',
    projectId: 'prj_vendor',
    stream: 'main',
    intent: 'initial',
    schemaVersion: 1,
    artifactRefs: [],
    taskId: 'task_1',
    seq: 1,
    definitionKey: 'acme:vendor',
    definitionVersion: 2,
    createdAt: Date.UTC(2026, 9, 2, 9, 30),
    storage: { placement: 'inline', bytes: 6_240, readable: true },
  },
  {
    id: 'pout_task_2',
    projectId: 'prj_vendor',
    stream: 'main',
    intent: 'clarify',
    schemaVersion: 1,
    artifactRefs: [],
    taskId: 'task_2',
    seq: 2,
    definitionKey: 'acme:vendor',
    definitionVersion: 2,
    createdAt: Date.UTC(2026, 9, 9, 14, 5),
    storage: { placement: 'offloaded', bytes: 412_000, readable: true },
  },
]

const FINDINGS: ResearchProjectView['findings'] = [
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
    revisionId: 'pout_task_1',
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
    revisionId: 'pout_task_2',
    seq: 2,
    notes: [],
  },
]

const LEARNINGS: ResearchProjectView['learnings'] = [
  {
    title: 'A sandbox tenant exists',
    detail: 'Each account gets one sandbox tenant with production limits.',
    revisionId: 'pout_task_1',
  },
]

const COVERAGE: ResearchProjectView['coverage'] = {
  total: { answered: 1, partial: 0, unanswered: 1, blocked: 1 },
  byTopic: [
    { topicId: 'auth', counts: { answered: 1, partial: 0, unanswered: 0, blocked: 1 } },
    { topicId: 'limits', counts: { answered: 0, partial: 0, unanswered: 1, blocked: 0 } },
  ],
  adhoc: { answered: 0, partial: 0, unanswered: 0, blocked: 0 },
  retiredQuestionIds: [],
}

const kindView: ResearchProjectView = {
  summary: 'The API uses OAuth client credentials; scopes are documented, quotas are not.',
  latestRevisionId: 'pout_task_2',
  findings: FINDINGS,
  learnings: LEARNINGS,
  adhocQuestions: [],
  coverage: COVERAGE,
}

export const researchBoardView: ProjectBoardView = {
  projectId: 'prj_vendor',
  kind: 'research',
  pin: {
    definitionKey: 'acme:vendor',
    definitionVersion: 2,
    definitionHash: 'f00d',
    inputs: { region: 'eu' },
  },
  definition: {
    kind: 'research',
    key: 'acme:vendor',
    version: 2,
    title: 'Content platform integration',
    spec: {
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
    },
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
  outcomes: researchOutcomes,
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
  view: kindView,
}

export const outcomePolicy: OutcomeStoragePolicyView = {
  account: { inlineMaxBytes: 262_144 },
  workspace: null,
  project: { offload: 'enabled' },
  effective: { inlineMaxBytes: 262_144, offload: 'enabled' },
}

/** A project of a kind with no reader of its own: a notes kind whose outcomes are plain documents. */
export const notesBoardView: ProjectBoardView = {
  projectId: 'prj_notes',
  kind: 'notes',
  pin: null,
  definition: null,
  definitionChanged: false,
  outcomes: [
    {
      id: 'pout_note_1',
      projectId: 'prj_notes',
      stream: 'main',
      intent: 'draft',
      schemaVersion: 1,
      artifactRefs: [],
      taskId: 'task_note',
      seq: 1,
      definitionKey: null,
      definitionVersion: null,
      createdAt: Date.UTC(2026, 9, 12, 11, 0),
      storage: { placement: 'inline', bytes: 340, readable: true },
    },
  ],
  credentials: [],
  view: null,
}

export const notesOutcomeBody = {
  heading: 'Decisions',
  items: ['Ship the importer behind a flag.', 'Keep the legacy export for one release.'],
}
