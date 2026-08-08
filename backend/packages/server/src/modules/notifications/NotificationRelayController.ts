import { Hono } from 'hono'
import type { Notification } from '@cat-factory/kernel'
import { NOTIFICATION_DELIVERY_REASONS, isNotificationDeliveryReason } from '@cat-factory/kernel'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'
import type { DelegatedNotificationRequest } from '../../notifications/machineNotifications.js'
import { logger } from '../../observability/logger.js'

/**
 * The mothership-mode notification DELIVERY machine API: `POST /internal/notifications/deliver`.
 *
 * A mothership-mode local node raises notifications locally and persists them on the mothership
 * (the remote `notificationRepository`), but it holds none of the org's external delivery
 * credentials — the Slack bot token is sealed with the MOTHERSHIP's encryption key, which never
 * reaches a laptop. Without this endpoint a `merge_review` / `ci_failed` / `release_regression`
 * raised on a developer's machine lands in the inbox and stops there.
 *
 * The node posts only the notification's IDENTITY; the mothership re-reads the row from its OWN
 * store and delivers THAT through `container.machineNotificationDelivery`. So a compromised node
 * token can at worst ask for a re-delivery of a row that already exists in an account it can
 * already reach — it can never inject forged text into the org's Slack.
 *
 * Security mirrors {@link eventsRelayController} / {@link persistenceController}: gated NOT by the
 * user-session `authGate` (its `/internal` prefix is bypassed) but by a `machine`-audience token,
 * checked FIRST so the endpoint is not probeable without one, then account-scoped — the
 * workspace is resolved to its owning account and anything outside the token's scope is a uniform
 * 404 (the auth gate's existence-non-leak policy), as is a notification the workspace doesn't own.
 *
 * IN-APP delivery is deliberately out of scope here: the laptop's own in-app channel already
 * relays its `notification` WorkspaceEvent to the mothership's browsers over
 * `POST /internal/events/publish`, so each facade wires this seam with its EXTERNAL channels only
 * and the two `/internal/*` surfaces never both push the same frame.
 *
 * Mounted on BOTH facades so either a Node or a Cloudflare deployment can be a mothership. A
 * facade with no external channel (no Slack) or that is not a mothership (no `repositories` to
 * resolve scope / read the row) serves a 503. See docs/initiatives/mothership-mode.md.
 */
export function notificationRelayController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/notifications/deliver', async (c) => {
    const container = c.get('container')

    // Auth first (before the seam probe) — a token-less caller can't tell a mothership with
    // external channels from one without.
    const payload = await verifyMachineRequest(c)
    if (!payload) {
      return c.json(
        { ok: false, error: { code: 'forbidden', message: 'invalid machine token' } },
        403,
      )
    }

    const delivery = container.machineNotificationDelivery
    // Scope resolution + the authoritative row read both come from the mothership's own registry,
    // exactly like the persistence RPC's scope check.
    const workspaceRepository = container.repositories?.workspaceRepository
    const notificationRepository = container.repositories?.notificationRepository
    if (
      !delivery ||
      typeof workspaceRepository?.accountOf !== 'function' ||
      typeof notificationRepository?.get !== 'function'
    ) {
      return c.json(
        { ok: false, error: { code: 'internal', message: 'notification delivery not enabled' } },
        503,
      )
    }

    let body: DelegatedNotificationRequest
    try {
      body = (await c.req.json()) as DelegatedNotificationRequest
    } catch {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'invalid request body' } },
        422,
      )
    }
    if (!body || typeof body.workspaceId !== 'string' || typeof body.notificationId !== 'string') {
      return c.json(
        {
          ok: false,
          error: { code: 'validation', message: 'workspaceId and notificationId are required' },
        },
        422,
      )
    }
    // The delivery EDGE, which the persisted row cannot supply (a raise and an escalation are
    // both `open`). Refused rather than defaulted: see `DelegatedNotificationRequest`.
    if (!isNotificationDeliveryReason(body.reason)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'validation',
            message: `reason must be one of ${NOTIFICATION_DELIVERY_REASONS.join(', ')}`,
          },
        },
        422,
      )
    }
    const reason = body.reason

    const log = logger.child({
      scope: 'notificationDelegation',
      nodeId: payload.nodeId,
      userId: payload.userId,
    })
    const denied = () =>
      c.json({ ok: false, error: { code: 'not_found', message: 'Not found' } }, 404)

    // Account-scope binding: resolve the workspace to its owning account and refuse anything
    // outside the token's scope as 404 (no existence leak), matching the persistence RPC.
    const accountId = (await (
      workspaceRepository.accountOf(body.workspaceId) as Promise<string | null | undefined>
    ).catch(() => undefined)) as string | null | undefined
    if (!accountId || !payload.scope.accountIds.includes(accountId)) {
      log.warn('notification delegation: workspace out of scope', { workspaceId: body.workspaceId })
      return denied()
    }

    // Read the AUTHORITATIVE row (workspace-scoped, so a notification of another workspace can't
    // be addressed through an in-scope one) — the node's request body never supplies content.
    let notification: Notification | null
    try {
      notification = (await notificationRepository.get(
        body.workspaceId,
        body.notificationId,
      )) as Notification | null
    } catch (error) {
      log.error('notification delegation: row read failed', {
        workspaceId: body.workspaceId,
        notificationId: body.notificationId,
        err: error instanceof Error ? error.message : String(error),
      })
      return c.json({ ok: false, error: { code: 'internal', message: 'Internal error' } }, 500)
    }
    if (!notification) return denied()

    // Best-effort by the channel contract — the persisted row is the source of truth, and the
    // caller must not see a delivery hiccup as a failed raise. A channel that throws (the composite
    // already isolates per-channel failures) is logged, not propagated.
    try {
      await delivery.deliver(body.workspaceId, notification, reason)
    } catch (error) {
      log.warn('notification delegation: delivery failed', {
        workspaceId: body.workspaceId,
        notificationId: body.notificationId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
    return c.json({ ok: true })
  })

  return app
}
