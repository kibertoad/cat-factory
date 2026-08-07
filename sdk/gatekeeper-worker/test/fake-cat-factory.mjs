// A scripted cat-factory `/api/v1` origin, bound as the Worker pool's `outboundService`.
//
// Why a fake and not the real backend: the assertions this suite exists to make are all about
// what the GATEKEEPER does with a call, and every one of them is observable in the response this
// origin hands back. Rather than recording requests somewhere the test has to reach across an
// isolate boundary to read, unrecognised routes ECHO what they received; the echo travels back
// through the binding, through Cap'n Web, into the test's own assertion. So "the approve reached
// the right path, with this actor's own minted key" is a plain `expect` on a returned value.
//
// It is a plain `.mjs` module worker rather than a TypeScript source file because Miniflare takes
// it as a script string; keeping it out of the build also keeps it out of what an operator copies.
//
// Scenarios are keyed on the RUN ID, so a spec picks one by naming the run it drives:
//
//   run_pending    a parked approval-gate, quorum of one          → approving settles it
//   run_quorum     a parked approval-gate needing two approvals   → approving records, does not settle
//   run_exceeded   a companion gate at its automatic-rework cap   → only resolve-exceeded settles it
//   run_stale      nothing parked, and an unanswerable wait named → answering reports it
//   run_settled    an approval gate already answered elsewhere    → the entry is present but settled
//   run_review     a parked requirements review                   → the loop verbs, not approve
//   run_fork       a parked implementation-fork choice            → choose
//   run_followups  live follow-up items on a RUNNING run          → answerable while not blocked
//   run_both       a follow-up triage AND an approval gate        → answering needs a `kind`
//   run_unknown    a park kind this Gatekeeper does not model     → stale, saying which
//   run_rotated    every call 401s until the key is re-minted     → the credential-recovery path
//
// A run whose decision list changes after an action declares the change in `AFTER`; anything else
// answers the same list it did before, which is what a real surface does for an action that
// records without settling.

const KEY_401_RUNS = new Set(['run_rotated'])

/**
 * Identities whose first minted key this origin has declared dead.
 *
 * Scoped to the identity rather than kept as one flag, so the rotation scenario cannot change what
 * a different actor's mint answers: a global would make every later spec's key assertion depend on
 * whether the rotation spec had run yet.
 */
const revokedIdentities = new Set()

/** The `externalIdentity` a minted bearer names, read back out of the token the fake issued. */
function identityOf(authorization) {
  return authorization.match(/^Bearer cf_live_pak_[a-z]+_(.+)\.[a-z]+-secret$/)?.[1] ?? null
}

/**
 * How many keys this origin has actually issued, per identity, readable at `/__mints`.
 *
 * The one fact about the Gatekeeper that is NOT observable in a response: a second mint answers a
 * perfectly good key, so a caller cannot tell it happened. It is exactly the fact the claim exists
 * to control: two pipelined first calls both minting leaves the loser's credential live upstream
 * with nothing in the Durable Object recording it.
 */
const mintCounts = new Map()

function approvalGate(overrides = {}) {
  return {
    kind: 'approval-gate',
    approvalId: 'ap_1',
    exceeded: false,
    feedback: null,
    proposal: 'the agent’s proposal',
    recordedApprovals: 0,
    requiredApprovals: 1,
    status: 'pending',
    stepIndex: 2,
    stepKind: 'coder',
    ...overrides,
  }
}

function requirementsReview(overrides = {}) {
  return {
    kind: 'requirements-review',
    reviewId: 'rr_1',
    taskId: 'blk_1',
    status: 'ready',
    iteration: 1,
    maxIterations: 3,
    findings: [
      {
        itemId: 'ri_1',
        category: 'gap',
        severity: 'blocking',
        title: 'Which database?',
        detail: 'The task names no store.',
        status: 'open',
        reply: null,
      },
    ],
    incorporatedRequirements: null,
    ...overrides,
  }
}

function forkDecision(overrides = {}) {
  return {
    kind: 'fork',
    status: 'awaiting_choice',
    seamSummary: 'Two ways to slice it.',
    forks: [
      { id: 'fk_1', title: 'In place', approach: '…', tradeoffs: '…', risk: 'low' },
      { id: 'fk_2', title: 'New module', approach: '…', tradeoffs: '…', risk: 'medium' },
    ],
    ...overrides,
  }
}

function followUps(overrides = {}) {
  return {
    kind: 'follow-ups',
    stepKind: 'coder',
    stepIndex: 3,
    loops: 0,
    maxLoops: 2,
    items: [
      {
        itemId: 'fu_1',
        kind: 'question',
        title: 'Should the cache be shared?',
        detail: '…',
        suggestedAction: null,
        status: 'pending',
        answer: null,
        ticketExternalId: null,
        ticketUrl: null,
      },
    ],
    ...overrides,
  }
}

function decisionList(runId, { decisions, parked = true, status = 'running', unanswerable = [] }) {
  return { runId, taskId: 'blk_1', status, parked, decisions, unanswerable }
}

/** The list a run answers BEFORE any action against it. */
function listFor(runId) {
  switch (runId) {
    case 'run_quorum':
      return decisionList(runId, { decisions: [approvalGate({ requiredApprovals: 2 })] })
    case 'run_exceeded':
      return decisionList(runId, { decisions: [approvalGate({ exceeded: true })] })
    case 'run_settled':
      // A gate the SPA answered while the card sat in the inbox. Present, and not pending: a
      // Gatekeeper that answered the first entry of a matching kind would post against it.
      return decisionList(runId, { decisions: [approvalGate({ status: 'approved' })] })
    case 'run_review':
      return decisionList(runId, { decisions: [requirementsReview()] })
    case 'run_fork':
      return decisionList(runId, { decisions: [forkDecision()] })
    case 'run_followups':
      // Follow-ups accrue LIVE, so the run is `running` rather than `blocked` and is still
      // answerable. A predicate keyed on the run's status would miss this one.
      return decisionList(runId, { decisions: [followUps()], parked: false })
    case 'run_both':
      return decisionList(runId, { decisions: [followUps(), approvalGate()] })
    case 'run_unknown':
      return decisionList(runId, { decisions: [{ kind: 'quantum-review', status: 'pending' }] })
    case 'run_stale':
      return decisionList(runId, {
        decisions: [],
        parked: false,
        status: 'done',
        unanswerable: [
          { reason: 'human_wait_gate', detail: 'A reviewer has to approve the pull request.' },
        ],
      })
    default:
      return decisionList(runId, { decisions: [approvalGate()] })
  }
}

/**
 * The list a run answers AFTER an action, when the action changes it.
 *
 * `run_quorum` keeps the gate pending with one vote recorded, which is the case an integration
 * gets wrong by treating a 200 as "the run moved". `run_review` keeps the review `ready` after a
 * reply, because a reply is recorded and folded in later, not a settlement.
 */
function listAfter(runId) {
  switch (runId) {
    case 'run_quorum':
      return decisionList(runId, {
        decisions: [approvalGate({ requiredApprovals: 2, recordedApprovals: 1 })],
      })
    case 'run_review':
      return decisionList(runId, { decisions: [requirementsReview()] })
    case 'run_both':
      // The approval gate settled; the follow-up triage is untouched and still holds the run.
      return decisionList(runId, { decisions: [followUps()] })
    default:
      return decisionList(runId, { decisions: [], parked: false, status: 'running' })
  }
}

const ACTION_ROUTE = /^\/api\/v1\/runs\/([^/]+)\/decisions\/(.+)$/

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const authorization = request.headers.get('authorization') ?? ''
    const raw = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text()
    const body = raw.length > 0 ? JSON.parse(raw) : null
    const echo = { echo: { method: request.method, path: url.pathname, authorization, body } }

    // Not part of `/api/v1`: the suite's own read of what this origin has been asked to do.
    if (url.pathname === '/__mints') {
      return Response.json(Object.fromEntries(mintCounts))
    }

    if (url.pathname === '/api/v1/keys' && request.method === 'POST') {
      const scope = body?.scope ?? 'write'
      const identity = body?.externalIdentity ?? null
      // A mint AFTER a revocation answers a distinguishable secret, which is how a spec can see
      // that the recovery path minted rather than re-read the dead one.
      const generation = revokedIdentities.has(identity) ? 'reminted' : 'minted'
      const id = `pak_${scope}_${identity ?? 'anon'}`
      mintCounts.set(id, (mintCounts.get(id) ?? 0) + 1)
      return Response.json(
        {
          key: {
            id,
            accountId: 'acc_1',
            label: body?.label ?? '',
            scope,
            externalIdentity: identity,
            createdAt: 0,
            createdByKeyId: 'pak_provisioning',
            createdByUserId: null,
            lastUsedAt: null,
            revokedAt: null,
          },
          // The real surface returns `cf_live_<keyId>.<secret>`, and the suite asserts on this
          // exact string arriving in a later call's `authorization`: that is how it can see
          // that a call went out on the ACTOR's key rather than the provisioning one.
          secret: `cf_live_${id}.${generation}-secret`,
        },
        { status: 201 },
      )
    }

    const revokeMatch = url.pathname.match(/^\/api\/v1\/keys\/([^/]+)$/)
    if (revokeMatch && request.method === 'DELETE') {
      return Response.json({ key: { id: revokeMatch[1], revokedAt: 1 } })
    }

    const listMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/decisions$/)
    if (listMatch && request.method === 'GET') {
      const runId = listMatch[1]
      // The rotated-key scenario: the FIRST secret a caller presents is declared dead, so the
      // Gatekeeper has to drop it and mint again to get anywhere.
      if (KEY_401_RUNS.has(runId) && authorization.endsWith('.minted-secret')) {
        const identity = identityOf(authorization)
        if (identity !== null) revokedIdentities.add(identity)
        return Response.json(
          { error: { code: 'unauthorized', message: 'This key was revoked.' } },
          { status: 401 },
        )
      }
      return Response.json(listFor(runId))
    }

    const actionMatch = url.pathname.match(ACTION_ROUTE)
    if (actionMatch && request.method === 'POST') {
      const [, runId] = actionMatch
      return Response.json({ ...listAfter(runId), ...echo })
    }

    return Response.json(echo)
  },
}
