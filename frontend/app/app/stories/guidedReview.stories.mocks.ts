// One guided review of pull request 212 on the auth service: its overview, the thread about the
// refresh-token race, and the comment drafts that thread produced. The review, the questions, the
// answers and the comments are made up.
import type {
  GuidedReviewCommentDraft,
  GuidedReviewMessage,
  GuidedReviewSession,
  GuidedReviewThreadView,
} from '@cat-factory/contracts'
import { AUTH_REPO_ID } from './vcs.stories.mocks'

/** The review of pull request 212 on the auth service, with a finished overview. */
export function guidedReviewSession(
  overview: Partial<GuidedReviewSession['overview']> = {},
): GuidedReviewSession {
  return {
    id: 'grs_auth_212',
    provider: 'github',
    repoId: String(AUTH_REPO_ID),
    owner: 'acme',
    repo: 'auth-service',
    prNumber: 212,
    prTitle: 'Rotate refresh tokens on use',
    reviewedHeadSha: '9c1e4b7a2f60d8e3b5a1c4f7e2d9b8a6c3f1e0d4',
    baseRef: 'main',
    createdBy: 'usr_maya',
    createdByKind: 'user',
    createdAt: Date.UTC(2026, 9, 12, 10, 0),
    updatedAt: Date.UTC(2026, 9, 12, 10, 3),
    overview: {
      status: 'complete',
      generation: 1,
      model: 'workers-ai:@cf/zai-org/glm-5.2',
      failure: null,
      content: {
        summary:
          'Each refresh now issues a new refresh token and revokes the one it used. A reused ' +
          'token revokes every token in its family.',
        intent: 'Implements ADR 0007, so a stolen refresh token stops working after one use.',
        meaningfulChanges: [
          {
            title: 'Token families',
            detail: 'Refresh tokens carry a `familyId`, and a new table holds revoked families.',
            paths: ['src/sessions/refresh.ts', 'migrations/0031_token_families.sql'],
          },
          {
            title: 'Reuse detection',
            detail: 'A refresh with a revoked token revokes its family and answers 401.',
            paths: ['src/sessions/refresh.ts'],
          },
        ],
        consequences: [
          {
            title: 'Clients must store the new token',
            detail: 'A client that keeps the old token is signed out at its next refresh.',
          },
        ],
        risks: [
          {
            title: 'Concurrent refresh race',
            detail: 'Two refreshes with one token can both pass the revocation check.',
            severity: 'high',
            paths: ['src/sessions/refresh.ts'],
          },
          {
            title: 'Migration locks the sessions table',
            detail: 'The new column has a default, which rewrites the table.',
            severity: 'medium',
            paths: ['migrations/0031_token_families.sql'],
          },
          {
            title: 'Log line names the family id',
            detail: 'Not a secret, but it links sessions in the logs.',
            severity: 'low',
            paths: ['src/sessions/refresh.ts'],
          },
        ],
        focusAreas: [
          {
            title: 'The revoke and lookup order',
            why: 'This is where the race is.',
            anchors: [{ path: 'src/sessions/refresh.ts', startLine: 52, endLine: 58 }],
          },
        ],
        suggestedQuestions: [
          { id: 'q_race', question: 'Can two refreshes with one token both succeed?' },
          { id: 'q_mobile', question: 'What happens to a mobile client that is offline?' },
        ],
      },
      ...overview,
    },
  }
}

/** When the race thread starts. */
const START = Date.UTC(2026, 9, 12, 10, 5)

/** Message `seq` of the thread, one minute after the one before it. */
export function guidedReviewMessage(
  seq: number,
  role: GuidedReviewMessage['role'],
  overrides: Partial<GuidedReviewMessage> = {},
): GuidedReviewMessage {
  const at = START + seq * 60_000
  return {
    id: `grm_rotation_${seq}`,
    threadId: 'grt_rotation',
    sessionId: 'grs_auth_212',
    seq,
    role,
    kind: 'answer',
    depth: 'inline',
    content: '',
    status: 'complete',
    citations: [],
    failure: null,
    draftReport: null,
    model: role === 'assistant' ? 'workers-ai:@cf/zai-org/glm-5.2' : null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

export const raceQuestion = guidedReviewMessage(1, 'user', {
  content: 'Can two refreshes with one token both succeed?',
})
export const raceAnswer = guidedReviewMessage(2, 'assistant', {
  content:
    'Yes. `refresh()` reads the token, checks `revokedAt`, and only then writes the revocation ' +
    'in a second statement. Two requests that read before either writes both pass the check, ' +
    'and each issues a new token.\n\n' +
    'Reuse detection does not fire either, because neither request sees a revoked token.',
  citations: [
    { path: 'src/sessions/refresh.ts', startLine: 52, endLine: 58 },
    { path: 'src/sessions/store.ts', startLine: 41 },
  ],
})
export const indexQuestion = guidedReviewMessage(3, 'user', {
  content: 'Would a unique index on the family and its generation stop it?',
})
export const indexAnswer = guidedReviewMessage(4, 'assistant', {
  content:
    'It would. With a unique index on `(family_id, generation)` the second insert fails, and ' +
    'the request that loses can treat the failure as reuse. The migration adds `family_id` ' +
    'but no generation column yet.',
  citations: [{ path: 'migrations/0031_token_families.sql' }],
})

/** The race thread with `messages`, titled by its first question. */
export function guidedReviewThread(messages: GuidedReviewMessage[]): GuidedReviewThreadView {
  return {
    thread: {
      id: 'grt_rotation',
      sessionId: 'grs_auth_212',
      title: raceQuestion.content,
      createdBy: 'usr_maya',
      createdAt: START,
      updatedAt: messages.at(-1)!.updatedAt,
    },
    messages,
  }
}

/** A proposed draft on the refresh-token race, with the parts a story changes overridable. */
export function guidedReviewDraft(
  overrides: Partial<GuidedReviewCommentDraft> = {},
): GuidedReviewCommentDraft {
  return {
    id: 'grd_rotation_race',
    sessionId: 'grs_auth_212',
    threadId: 'grt_rotation',
    messageId: 'grm_rotation_6',
    path: 'src/sessions/refresh.ts',
    line: 58,
    startLine: 52,
    side: 'RIGHT',
    body:
      'Two concurrent refreshes with the same token both pass the `revokedAt` check before ' +
      'either writes it. Revoke inside the same transaction as the lookup.',
    rationale:
      'The ADR requires a reused token to revoke the whole family, and this race skips it.',
    status: 'proposed',
    postError: null,
    postedUrl: null,
    rev: 1,
    createdAt: Date.UTC(2026, 9, 12, 10, 14),
    updatedAt: Date.UTC(2026, 9, 12, 10, 14),
    ...overrides,
  }
}
