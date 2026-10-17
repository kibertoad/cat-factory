// The implementation-fork decision on the login task's coder step: the proposer's three
// approaches to refresh token rotation, and a chat about them. The approaches and the chat are
// made up; the ids follow the engine's `fork_*` form.
import type { ForkChatMessage, ForkDecisionStepState, ForkOption } from '@cat-factory/contracts'

const AT = Date.UTC(2026, 9, 12, 10, 0)

export const forkOptions: ForkOption[] = [
  {
    id: 'fork_session_service',
    title: 'Rotate in the session service',
    summary: 'The session service issues and revokes refresh tokens, as it issues sessions now.',
    approach:
      'Add a token family table to the session store. The refresh handler in ' +
      'src/session/refresh.ts issues a new token, marks the old one used, and revokes the ' +
      'family when a used token comes back. The login handler starts a family.',
    tradeoffs: [
      'One owner for every session rule, beside the code that issues sessions',
      'Each refresh writes one row more to the session store',
    ],
    riskNotes: 'Adds a table and a migration; a rollback leaves the table behind.',
    recommended: true,
  },
  {
    id: 'fork_gateway',
    title: 'Rotate at the API gateway',
    summary: 'The gateway swaps the token on each refresh, and the session service stays as is.',
    approach:
      'Add a refresh filter to the gateway that calls the session service for a new token and ' +
      'keeps the used ones in the gateway cache for the reuse check.',
    tradeoffs: [
      'No change to the session service',
      'The reuse check is lost when the gateway cache is flushed',
      'A second service now knows the session rules',
    ],
    riskNotes: null,
  },
  {
    id: 'fork_deny_list',
    title: 'Stateless tokens with a deny list',
    summary: 'Signed refresh tokens, and a deny list of the used ones until they expire.',
    approach:
      'Sign refresh tokens with the session key, carry the family id in the claims, and keep ' +
      'used token ids in Redis with the token lifetime as the TTL.',
    tradeoffs: ['No database write on a refresh', 'Revoking a family needs a scan of the list'],
    riskNotes: 'Changes the token format: every client signs in again after the release.',
  },
]

function message(n: number, role: ForkChatMessage['role'], text: string): ForkChatMessage {
  return { id: `fmsg_${n}`, role, text, createdAt: AT + n * 60_000 }
}

/** A question about the gateway approach, and the answer. */
export const forkChat: ForkChatMessage[] = [
  message(1, 'human', 'Does the gateway approach still catch a reused token after a restart?'),
  message(
    2,
    'assistant',
    'No. The gateway keeps the used tokens in its cache, so a restart or a flush clears them ' +
      'and a reused token is accepted once. The session service approach keeps them in the ' +
      'session store, so they survive a restart.',
  ),
]

/** The decision waiting for a pick, with the seam the proposer found. */
export function forkDecisionState(
  overrides: Partial<ForkDecisionStepState> = {},
): ForkDecisionStepState {
  return {
    status: 'awaiting_choice',
    seamSummary:
      'Refresh tokens are issued in src/session/refresh.ts and checked by the gateway auth ' +
      'filter; nothing records a used token today.',
    forks: forkOptions,
    chat: [],
    maxChatTurns: 15,
    chosen: null,
    model: 'claude-sonnet-5-5',
    ...overrides,
  }
}
