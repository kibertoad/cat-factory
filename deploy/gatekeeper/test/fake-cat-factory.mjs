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
//   run_pending   a parked approval-gate, quorum of one          → approving settles it
//   run_quorum    a parked approval-gate needing two approvals   → approving records, does not settle
//   run_exceeded  a companion gate at its automatic-rework cap   → the plain approve is refused
//   run_stale     nothing parked, and an unanswerable wait named → answering reports it

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

function decisionList(runId, { decisions, parked = true, status = 'running', unanswerable = [] }) {
  return { runId, taskId: 'blk_1', status, parked, decisions, unanswerable }
}

function listFor(runId) {
  switch (runId) {
    case 'run_quorum':
      return decisionList(runId, { decisions: [approvalGate({ requiredApprovals: 2 })] })
    case 'run_exceeded':
      return decisionList(runId, { decisions: [approvalGate({ exceeded: true })] })
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

// What the approve route answers: the run's WHOLE list, re-read after the action, exactly as the
// real surface does. `run_quorum` keeps the gate pending with one vote recorded, which is the
// case an integration gets wrong by treating a 200 as "the run moved".
function listAfterApprove(runId) {
  if (runId === 'run_quorum') {
    return decisionList(runId, {
      decisions: [approvalGate({ requiredApprovals: 2, recordedApprovals: 1 })],
    })
  }
  return decisionList(runId, { decisions: [], parked: false, status: 'running' })
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const authorization = request.headers.get('authorization') ?? ''
    const raw = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text()
    const body = raw.length > 0 ? JSON.parse(raw) : null
    const echo = { echo: { method: request.method, path: url.pathname, authorization, body } }

    if (url.pathname === '/api/v1/keys' && request.method === 'POST') {
      const scope = body?.scope ?? 'write'
      const identity = body?.externalIdentity ?? null
      const id = `pak_${scope}_${identity ?? 'anon'}`
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
          secret: `cf_live_${id}.minted-secret`,
        },
        { status: 201 },
      )
    }

    const listMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/decisions$/)
    if (listMatch && request.method === 'GET') {
      return Response.json(listFor(listMatch[1]))
    }

    const actionMatch = url.pathname.match(
      /^\/api\/v1\/runs\/([^/]+)\/decisions\/approvals\/([^/]+)\/(approve|request-changes|reject|resolve-exceeded)$/,
    )
    if (actionMatch && request.method === 'POST') {
      const [, runId] = actionMatch
      return Response.json({ ...listAfterApprove(runId), ...echo })
    }

    return Response.json(echo)
  },
}
