import { describe, expect, it } from 'vitest'
import type { Block, RequirementReview, SourceTask, WorkspaceSnapshot } from '@cat-factory/kernel'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'
import { signFakeTrackerDelivery } from '../fakeTrackerWebhook.js'

// Cross-runtime conformance for INBOUND tracker webhooks — push-driven intake and ticket replies
// to a parked requirements review (backend/docs/adr/0032-tracker-webhook-intake.md).
//
// What only a shared suite can prove here is that BOTH facades wired the whole chain, because
// every link is per-facade: the route must be mounted, the session gate must let an anonymous
// tracker POST through, the per-connection secret must decrypt out of the store the facade chose,
// the `trackerWebhook` gateway must exist (queue on a real deployment, inline here), and the
// resulting handle must reach a `TrackerWebhookService` composed against that facade's repositories.
// A facade that forgot any one of them fails a test instead of silently never answering a reporter.
//
// The queue/inline DUALITY is asserted by construction rather than by a mock: neither test harness
// binds a queue, so `enqueueEvent` reports `false` on both and the receiver takes its inline path —
// which is exactly the branch that has to work on a facade with no queue configured, and the branch
// whose absence would make every conformance assertion below hang instead of fail. The queued
// branch is a one-line producer per facade over the same already-parsed event.

/** Seed a workspace with a connected fake tracker, a linked issue, and a minted webhook secret. */
async function setupTracker(
  app: ConformanceApp,
): Promise<{ ws: string; blockId: string; secret: string; externalId: string }> {
  const { call } = app
  const snapshot = await app.createWorkspace({ seed: true })
  const ws = snapshot.workspace.id

  const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
    type: 'service',
    position: { x: 0, y: 0 },
  })
  await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
    credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 't' },
  })
  const externalId = 'PROJ-77'
  await call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: externalId })
  const created = await call<{ block: Block; task: SourceTask }>(
    'POST',
    `/workspaces/${ws}/tasks/create-block`,
    { source: 'jira', externalId, containerId: frame.body.id },
  )
  expect(created.status).toBe(201)

  const minted = await call<{ secret: string; deliveryPath: string; configured: boolean }>(
    'POST',
    `/workspaces/${ws}/task-sources/jira/webhook`,
    {},
  )
  expect(minted.status).toBe(201)
  expect(minted.body.configured).toBe(true)
  // The path the operator pastes must be the path the receiver actually serves — a mismatch fails
  // silently, as deliveries that simply never arrive.
  expect(minted.body.deliveryPath).toBe(`/webhooks/tasks/jira/${ws}`)

  return { ws, blockId: created.body.block.id, secret: minted.body.secret, externalId }
}

/**
 * POST a delivery to the receiver, signed with `secret` unless `sign: false`.
 *
 * The signature is computed over `JSON.stringify(event)` — byte-for-byte what the harness sends —
 * because the receiver verifies the RAW body. Signing anything else here would make every case
 * below fail for the wrong reason, and (worse) a receiver that verified a re-serialised parse
 * would pass, which is the classic signature bypass this whole shape exists to avoid.
 */
async function deliver(
  app: ConformanceApp,
  ws: string,
  secret: string,
  event: unknown,
  opts: { sign?: boolean; source?: string } = {},
) {
  const headers =
    opts.sign === false ? {} : await signFakeTrackerDelivery(secret, JSON.stringify(event))
  return app.call('POST', `/webhooks/tasks/${opts.source ?? 'jira'}/${ws}`, event, headers)
}

export function defineTrackerWebhookConformance(harness: ConformanceHarness): void {
  describe('tracker webhooks (push intake + ticket replies)', () => {
    it('rejects an unknown source, an unsigned delivery, and a connection with no secret', async () => {
      const app = harness.makeApp()
      const { call } = app
      const snapshot = await app.createWorkspace({ seed: true })
      const ws = snapshot.workspace.id
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })

      // Unknown `:source` — 404 before anything touches the container.
      const unknown = await deliver(app, ws, 'x', { kind: 'issue' }, { source: 'nope' })
      expect(unknown.status).toBe(404)

      // Connected but no secret minted yet ⇒ FAIL CLOSED. An empty HMAC key is one an attacker
      // also has, so this must never degrade to accepting the delivery. 503, because the remedy
      // belongs to the operator rather than the caller. (Signed with an arbitrary secret: the
      // receiver must refuse BEFORE it ever reaches verification, so which key was used is
      // irrelevant — and that is exactly the property under test.)
      const noSecret = await deliver(app, ws, 'any-secret-at-all', { kind: 'issue' })
      expect(noSecret.status).toBe(503)

      const minted = await call<{ secret: string }>(
        'POST',
        `/workspaces/${ws}/task-sources/jira/webhook`,
        {},
      )
      // Signed with the wrong secret, and unsigned entirely: both terse 401s.
      const wrongSecret = await deliver(app, ws, `${minted.body.secret}-tampered`, {
        kind: 'issue',
        source: 'jira',
        externalId: 'PROJ-1',
        action: 'created',
        title: 't',
        labels: [],
        issueType: null,
        url: null,
      })
      expect(wrongSecret.status).toBe(401)
      const unsigned = await deliver(
        app,
        ws,
        minted.body.secret,
        { kind: 'issue' },
        { sign: false },
      )
      expect(unsigned.status).toBe(401)
    })

    it('acks a verified delivery it does not act on, rather than making the tracker redeliver', async () => {
      // Trackers send far more event kinds than we consume. A verified-but-unrecognised delivery
      // must be ACKED: retrying it would just make the vendor redeliver a shape we will never act
      // on, forever.
      const app = harness.makeApp()
      const { ws, secret } = await setupTracker(app)
      const acked = await deliver(app, ws, secret, { kind: 'project_updated' })
      expect(acked.status).toBe(202)
    })

    it('applies a ticket reply to a parked review, and applies a REDELIVERY exactly once', async () => {
      const app = harness.makeApp()
      const { call } = app
      const { ws, blockId, secret, externalId } = await setupTracker(app)

      // A parked review with TWO open findings — the state a headless run reaches when the
      // reviewer raises questions and the engine echoes them onto this very issue.
      //
      // Two, not one, on purpose: answering the LAST open finding correctly triggers incorporation
      // (the D6 default that makes the ticket a complete surface), which calls a real reviewer
      // model no conformance harness has. Leaving a second finding open keeps this assertion on
      // the runtime-shaped half — receiver → gateway → service → the SPA's own `replyToItem` — and
      // leaves the auto-incorporate decision to `TrackerWebhookService`'s own unit tests, where it
      // has no runtime dimension.
      await app.seedReadyReview(ws, blockId, 2)
      const before = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      const itemId = before.body.items[0]!.id
      expect(before.body.items[0]!.status).toBe('open')

      const comment = {
        kind: 'comment',
        source: 'jira',
        externalId,
        commentId: 'cmt-1',
        // Leading prose is deliberate: a human answers and discusses in one comment, and only a
        // trigger line may ever be interpreted. It leads rather than trails because an `answer`
        // deliberately CONTINUES onto following lines until the next trigger (D4) — that is what
        // makes a multi-paragraph answer possible without escaping, and it means trailing prose
        // becomes part of the answer.
        body: [
          'Thanks for asking!',
          `@cat-factory answer ${itemId} Sessions should last 30 days.`,
        ].join('\n'),
        author: { id: 'u1', handle: 'reporter', email: 'r@acme.test', bot: false },
      }

      expect((await deliver(app, ws, secret, comment)).status).toBe(202)

      const applied = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      expect(applied.body.items[0]!.reply).toBe('Sessions should last 30 days.')
      expect(applied.body.items[0]!.status).toBe('answered')
      // The second finding is untouched, so the review is still parked — no incorporation.
      expect(applied.body.items[1]!.status).toBe('open')
      expect(applied.body.status).toBe('ready')

      // The REDELIVERY: every tracker retries, and the async queue retries on any error, so the
      // ingest claim is what stands between one reporter comment and an answer applied twice. A
      // second identical delivery must change nothing.
      expect((await deliver(app, ws, secret, comment)).status).toBe(202)
      const after = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      expect(after.body.items[0]!.reply).toBe('Sessions should last 30 days.')
      expect(after.body.updatedAt).toBe(applied.body.updatedAt)

      // A DIFFERENT comment id is a new answer and must apply — the claim dedups a redelivery,
      // never a genuine follow-up.
      expect(
        (
          await deliver(app, ws, secret, {
            ...comment,
            commentId: 'cmt-2',
            body: `@cat-factory answer ${itemId} Actually, make it 7 days.`,
          })
        ).status,
      ).toBe(202)
      const followUp = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      expect(followUp.body.items[0]!.reply).toBe('Actually, make it 7 days.')
    })

    it('ignores a comment with no command, and a comment from a bot author', async () => {
      const app = harness.makeApp()
      const { call } = app
      const { ws, blockId, secret, externalId } = await setupTracker(app)
      await app.seedReadyReview(ws, blockId, 2)
      const before = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      const itemId = before.body.items[0]!.id

      const base = {
        kind: 'comment',
        source: 'jira',
        externalId,
        author: { id: 'u1', handle: 'reporter', email: 'r@acme.test', bot: false },
      }

      // Ordinary discussion: no trigger line, so nothing is interpreted. Guessing at intent here
      // is exactly what the explicit grammar exists to prevent.
      expect(
        (
          await deliver(app, ws, secret, {
            ...base,
            commentId: 'chat-1',
            body: 'I think the session should probably last a month or so.',
          })
        ).status,
      ).toBe(202)

      // A BOT author — which is what the platform's own acknowledgement comment comes back as.
      // Without this the ack would feed itself.
      expect(
        (
          await deliver(app, ws, secret, {
            ...base,
            commentId: 'bot-1',
            author: { ...base.author, bot: true },
            body: `@cat-factory answer ${itemId} injected by a bot`,
          })
        ).status,
      ).toBe(202)

      const after = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      expect(after.body.items[0]!.status).toBe('open')
      expect(after.body.items[0]!.reply).toBeNull()
    })

    it('acks an issue event that matches no intake schedule, starting nothing', async () => {
      // The workspace has no `bug-intake` schedule, so a qualifying-looking issue event must be a
      // clean no-op: push intake fires SCHEDULES, and a workspace with none has nothing to fire.
      const app = harness.makeApp()
      const { ws, secret } = await setupTracker(app)
      const before = await app.drive(ws)

      const accepted = await deliver(app, ws, secret, {
        kind: 'issue',
        source: 'jira',
        externalId: 'PROJ-999',
        action: 'created',
        title: 'Something broke',
        labels: ['bug'],
        issueType: 'Bug',
        url: 'https://acme.atlassian.net/browse/PROJ-999',
      })
      expect(accepted.status).toBe(202)
      expect(await app.drive(ws)).toHaveLength(before.length)
    })

    it('edits the reply allow-list WITHOUT rotating the secret, and enforces it', async () => {
      // Two properties in one, because they only mean anything together: the operator can tighten
      // who may drive a run from a ticket, and doing so does NOT invalidate the secret already
      // pasted into the vendor's webhook form. A control that costs an outage is one nobody uses.
      const app = harness.makeApp()
      const { call } = app
      const { ws, blockId, secret, externalId } = await setupTracker(app)
      // TWO findings, answering ONE: leaving a finding open keeps the review parked, so this case
      // never reaches the auto-incorporation that would need a real model.
      await app.seedReadyReview(ws, blockId, 2)
      const before = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      const itemId = before.body.items[0]!.id

      const patched = await call<{ replyAllow: string; configured: boolean }>(
        'PATCH',
        `/workspaces/${ws}/task-sources/jira/webhook`,
        { replyAllow: 'ada@acme.test' },
      )
      expect(patched.status).toBe(200)
      expect(patched.body).toMatchObject({ replyAllow: 'ada@acme.test', configured: true })

      // The ORIGINAL secret still verifies — nothing was rotated behind the operator's back.
      const offList = await deliver(app, ws, secret, {
        kind: 'comment',
        source: 'jira',
        externalId,
        commentId: 'off-list-1',
        body: `@cat-factory answer ${itemId} from someone not on the list`,
        author: { id: 'u9', handle: 'stranger', email: 's@acme.test', bot: false },
      })
      expect(offList.status).toBe(202)

      // …and the allow-list is actually enforced: an author outside it changes nothing, silently.
      const unchanged = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      expect(unchanged.body.items[0]!.status).toBe('open')
      expect(unchanged.body.items[0]!.reply).toBeNull()

      // The listed author drives the same review through the same secret.
      const allowed = await deliver(app, ws, secret, {
        kind: 'comment',
        source: 'jira',
        externalId,
        commentId: 'on-list-1',
        body: `@cat-factory answer ${itemId} eu-west-1`,
        author: { id: 'u2', handle: 'ada', email: 'ada@acme.test', bot: false },
      })
      expect(allowed.status).toBe(202)
      const applied = await call<RequirementReview>(
        'GET',
        `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
      )
      expect(applied.body.items[0]!.reply).toContain('eu-west-1')
    })

    it('clearing the secret stops accepting deliveries without disconnecting the source', async () => {
      const app = harness.makeApp()
      const { call } = app
      const { ws, secret } = await setupTracker(app)

      const cleared = await call('DELETE', `/workspaces/${ws}/task-sources/jira/webhook`)
      expect(cleared.status).toBe(204)

      const rejected = await deliver(app, ws, secret, { kind: 'issue' })
      expect(rejected.status).toBe(503)

      // …and the connection itself is untouched: polling intake and imports keep working.
      const state = await call<{ configured: boolean; supported: boolean }>(
        'GET',
        `/workspaces/${ws}/task-sources/jira/webhook`,
      )
      expect(state.body.configured).toBe(false)
      expect(state.body.supported).toBe(true)
      const imported = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
        ref: 'PROJ-78',
      })
      expect(imported.status).toBe(201)
    })
  })

  registerPerTicketDispatchTests(harness)
}

/**
 * A workspace carrying one enabled PER-TICKET schedule, scoped to Jira project `PROJ`, on a
 * pipeline with no `bug-intake` step (which the mode refuses), plus its minted webhook secret.
 *
 * Extracted because the setup is eight REST calls of pure arrangement and two tests need the same
 * one; keeping it here also holds each `it` inside the per-function line budget.
 */
async function perTicketWorkspace(
  harness: ConformanceHarness,
  predicates: Record<string, unknown>,
): Promise<{ app: ConformanceApp; ws: string; frameId: string; secret: string }> {
  const app = harness.makeApp()
  const { call } = app
  const snapshot = await app.createWorkspace({ seed: true })
  const ws = snapshot.workspace.id
  const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
    type: 'service',
    position: { x: 0, y: 0 },
  })
  await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
    credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 't' },
  })
  const pipeline = await call<{ id: string }>('POST', `/workspaces/${ws}/pipelines`, {
    name: 'Feature intake',
    agentKinds: ['architect'],
  })
  const schedule = await call('POST', `/workspaces/${ws}/recurring-pipelines`, {
    frameId: frame.body.id,
    pipelineId: pipeline.body.id,
    name: 'Tracker triggers',
    onDemand: true,
    issueIntake: {
      source: 'jira',
      board: { jiraProjectKey: 'PROJ' },
      predicates,
      dispatch: 'per-ticket',
    },
  })
  expect(schedule.status).toBe(201)
  const minted = await call<{ secret: string }>(
    'POST',
    `/workspaces/${ws}/task-sources/jira/webhook`,
    {},
  )
  return { app, ws, frameId: frame.body.id, secret: minted.body.secret }
}

/**
 * PER-TICKET dispatch: the second mode a pushed issue event can take (D8) — the ticket itself
 * becomes a task and a run, rather than firing a schedule that drains the board.
 *
 * Registered from the suite above; split out purely to keep each function within the per-function
 * line budget, exactly as the document-source tests are in `integration-sources.ts`.
 */
function registerPerTicketDispatchTests(harness: ConformanceHarness): void {
  describe('tracker webhooks (per-ticket dispatch)', () => {
    it('dispatches a PER-TICKET trigger as its own task+run, and a redelivery exactly once', async () => {
      // The second dispatch mode: a matching issue event materialises THAT ticket as its own task
      // and starts the schedule's pipeline on it, instead of firing a schedule whose `bug-intake`
      // step drains the board oldest-first. This is how a ticket a human already triaged enters
      // the platform from the tracker it was filed in.
      const app = harness.makeApp()
      const { call } = app
      const snapshot = await app.createWorkspace({ seed: true })
      const ws = snapshot.workspace.id

      const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })

      // A plain pipeline with NO `bug-intake` step: per-ticket dispatch has already chosen the
      // ticket, so an intake step would go and pick a different one (and is refused at save).
      const pipeline = await call<{ id: string }>('POST', `/workspaces/${ws}/pipelines`, {
        name: 'Feature intake',
        agentKinds: ['architect'],
      })
      expect(pipeline.status).toBe(201)

      const schedule = await call<{ id: string }>('POST', `/workspaces/${ws}/recurring-pipelines`, {
        frameId: frame.body.id,
        pipelineId: pipeline.body.id,
        name: 'Tracker triggers',
        // On-demand is REQUIRED for per-ticket: a cadence tick has no triggering ticket.
        onDemand: true,
        issueIntake: {
          source: 'jira',
          board: { jiraProjectKey: 'PROJ' },
          predicates: { labels: ['accepted'] },
          dispatch: 'per-ticket',
        },
      })
      expect(schedule.status).toBe(201)

      const minted = await call<{ secret: string }>(
        'POST',
        `/workspaces/${ws}/task-sources/jira/webhook`,
        {},
      )
      const secret = minted.body.secret
      const externalId = 'PROJ-501'
      const event = {
        kind: 'issue',
        source: 'jira',
        externalId,
        action: 'created',
        title: 'Add bulk export',
        labels: ['accepted'],
        issueType: null,
        // Per-ticket dispatch checks the board scope, because nothing downstream will: there is no
        // vendor search to re-confine the work the way the queue mode's `bug-intake` step has.
        board: 'PROJ',
        url: null,
      }

      const delivered = await deliver(app, ws, secret, event)
      expect(delivered.status).toBe(202)

      // The ticket is now a task of its own under the frame, linked to the issue and running —
      // none of which the queue mode would produce (it reuses the schedule's one block).
      const tasks = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
      const row = tasks.body.find((t) => t.externalId === externalId)
      expect(row?.linkedBlockId).toBeTruthy()

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)
      const dispatched = snap.body.blocks.find((b) => b.id === row!.linkedBlockId)
      expect(dispatched?.parentId).toBe(frame.body.id)
      expect(dispatched?.executionId).toBeTruthy()

      // The run is HEADLESS, and it has to still say so after the round-trip through each facade's
      // real store: `intakeOrigin` rides the `agent_runs.detail` JSON, and the requirements-review
      // writeback is the only thing that will ever tell the requester their ticket is waiting on
      // them. Read back off the repository rather than the response, because the write side is
      // where a facade could drop it — and the failure would be invisible, a run that simply looks
      // like somebody started it in the app.
      const run = await app.executionRepository().getByBlock(ws, row!.linkedBlockId!)
      expect(run?.intakeOrigin).toBe('tracker')

      // A REDELIVERY (trackers retry, and an `updated` event follows a `created` one) must not
      // dispatch the ticket twice. The issue's single `linkedBlockId` is the idempotency: no claim
      // table, no second block, no second run.
      const again = await deliver(app, ws, secret, { ...event, action: 'updated' })
      expect(again.status).toBe(202)
      const after = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
      expect(after.body.filter((t) => t.externalId === externalId)).toHaveLength(1)
      const afterSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)
      const stillOne = afterSnap.body.blocks.find((b) => b.id === row!.linkedBlockId)
      expect(stillOne?.executionId).toBe(dispatched?.executionId)
    })

    it('WITHHOLDS a per-ticket dispatch the delivery does not qualify for', async () => {
      // The queue mode can afford to fire on a maybe: its run re-checks every predicate against the
      // vendor and completes as a no-op when nothing matches. Per-ticket has no such authority
      // behind it, so a delivery that is out of scope, or that cannot answer a configured
      // predicate, must not become a block and an agent run.
      const app = await perTicketWorkspace(harness, { labels: ['accepted'] })
      const base = {
        kind: 'issue',
        source: 'jira',
        action: 'created',
        title: 'Add bulk export',
        labels: ['accepted'],
        issueType: null,
        board: 'PROJ',
        url: null,
      }

      // Another project on the same connection. One Jira connection spans every project the
      // credential can see, so without the board check this ticket runs under a schedule that was
      // explicitly scoped away from it.
      const offScope = await deliver(app.app, app.ws, app.secret, {
        ...base,
        externalId: 'OTHER-1',
        board: 'OTHER',
      })
      expect(offScope.status).toBe(202)

      // The label predicate is what "already triaged" MEANS for this schedule, and this delivery
      // does not carry labels at all. Firing on it would dispatch an untriaged ticket (the exact
      // thing the mode exists to avoid), so it is withheld rather than assumed.
      const unlabelled = await deliver(app.app, app.ws, app.secret, {
        ...base,
        externalId: 'PROJ-777',
        labels: [],
      })
      expect(unlabelled.status).toBe(202)

      // Both are acked (a webhook consumer's only lever is retry, and neither is a failure), and
      // neither produced a task or a run.
      const tasks = await app.app.call<SourceTask[]>('GET', `/workspaces/${app.ws}/tasks`)
      expect(tasks.body.filter((t) => t.linkedBlockId)).toHaveLength(0)

      // The same schedule still dispatches a delivery that DOES qualify, so the guard is a
      // predicate rather than an outage.
      const qualifying = await deliver(app.app, app.ws, app.secret, {
        ...base,
        externalId: 'PROJ-778',
      })
      expect(qualifying.status).toBe(202)
      const after = await app.app.call<SourceTask[]>('GET', `/workspaces/${app.ws}/tasks`)
      expect(after.body.find((t) => t.externalId === 'PROJ-778')?.linkedBlockId).toBeTruthy()
    })

    it('refuses a per-ticket schedule that could also fire on a cadence', async () => {
      // The rule that keeps the two modes exclusive: without it, a cadence tick (which carries no
      // ticket) would silently fall back to draining the queue under a config saying `per-ticket`.
      const app = harness.makeApp()
      const { call } = app
      const snapshot = await app.createWorkspace({ seed: true })
      const ws = snapshot.workspace.id
      const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })
      await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 't',
        },
      })
      const pipeline = await call<{ id: string }>('POST', `/workspaces/${ws}/pipelines`, {
        name: 'Feature intake',
        agentKinds: ['architect'],
      })

      const refused = await call('POST', `/workspaces/${ws}/recurring-pipelines`, {
        frameId: frame.body.id,
        pipelineId: pipeline.body.id,
        name: 'Bad trigger',
        onDemand: false,
        recurrence: {
          intervalHours: 24,
          weekdays: [],
          windowStartHour: null,
          windowEndHour: null,
          timezone: 'UTC',
        },
        issueIntake: {
          source: 'jira',
          board: { jiraProjectKey: 'PROJ' },
          predicates: {},
          dispatch: 'per-ticket',
        },
      })
      expect(refused.status).toBe(422)
      expect(JSON.stringify(refused.body)).toContain('per_ticket_requires_on_demand')
    })
  })
}
