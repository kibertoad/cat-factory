import type { NotificationWebhook, PublicNotificationWebhook } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for the PUBLIC management surface of the outbound notification webhook
// (`/api/v1/notification-webhook`) — the enrolment half of the push channel, so a deployment driven
// entirely by API keys can register the receiver its notifications, run-lifecycle events and health
// alerts are delivered to.
//
// The repository parity behind it is pinned by `notification-webhook-suite` (both real stores, per
// column). What belongs HERE is the half that suite cannot see: that each facade MOUNTS the routes,
// resolves the workspace from the KEY rather than a path segment, holds the scope rung, and keeps
// the signing secret write-only on the way back out. A facade that wired the repository but not the
// controller fails here instead of shipping a push feature only a browser can turn on.
//
// See docs/initiatives/public-api-additions.md (slice C1).

const ENDPOINT = '/api/v1/notification-webhook'

/** Mint a public-API key of the given scope and return its bearer header. */
async function mintKey(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  workspaceId: string,
  scope: 'read' | 'write' | 'decide' | 'admin',
): Promise<Record<string, string>> {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: `conformance-webhook-${scope}`, scope },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

export function definePublicWebhookConformance(harness: ConformanceHarness): void {
  describe('public API — outbound webhook management', () => {
    it('registers, reads back, edits and removes the endpoint through the key alone', async () => {
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board.
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'admin')

      // Nothing registered is a VALUE, not a 404: an integration's startup self-check reads one
      // response shape rather than branching on a status the surface also uses for a bad path.
      const empty = await app.call<PublicNotificationWebhook>('GET', ENDPOINT, undefined, auth)
      expect(empty.status).toBe(200)
      expect(empty.body.webhook).toBeNull()

      const registered = await app.call<NotificationWebhook>(
        'PUT',
        ENDPOINT,
        {
          url: 'https://hooks.example.com/cat-factory',
          runEvents: ['run.completed', 'run.failed'],
          secret: 'a-signing-secret-of-length',
        },
        auth,
      )
      expect(registered.status).toBe(200)
      expect(registered.body).toMatchObject({
        url: 'https://hooks.example.com/cat-factory',
        runEvents: ['run.completed', 'run.failed'],
        enabled: true,
        hasSecret: true,
      })
      // The secret is write-only: the projection reports THAT one is set and never what it is, on
      // this surface exactly as on the session one. An `admin` key rotates; it cannot exfiltrate.
      expect(JSON.stringify(registered.body)).not.toContain('a-signing-secret-of-length')

      const read = await app.call<PublicNotificationWebhook>('GET', ENDPOINT, undefined, auth)
      expect(read.body.webhook).toEqual(registered.body)

      // An omitted field KEEPS its stored value, so subscribing to a new family is a one-field
      // write. A facade that re-defaulted here would silently unsign every later delivery.
      const edited = await app.call<NotificationWebhook>(
        'PUT',
        ENDPOINT,
        { url: 'https://hooks.example.com/cat-factory', alertEvents: ['platform_health.firing'] },
        auth,
      )
      expect(edited.status).toBe(200)
      expect(edited.body).toMatchObject({
        alertEvents: ['platform_health.firing'],
        runEvents: ['run.completed', 'run.failed'],
        hasSecret: true,
      })

      const removed = await app.call('DELETE', ENDPOINT, undefined, auth)
      expect(removed.status).toBe(204)
      const afterDelete = await app.call<PublicNotificationWebhook>(
        'GET',
        ENDPOINT,
        undefined,
        auth,
      )
      expect(afterDelete.body.webhook).toBeNull()
      // Idempotent: a teardown script need not first ask whether anything was there.
      expect((await app.call('DELETE', ENDPOINT, undefined, auth)).status).toBe(204)
    })

    it('refuses a key below `admin` and an endpoint the delivery path would reject', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const decideAuth = await mintKey(app, wsId, 'decide')

      // `decide` is the rung directly below, so this pins the ladder rather than just "some key is
      // refused". A valid-but-narrow key is a 403, distinct from the 401 an unknown key gets.
      const read = await app.call('GET', ENDPOINT, undefined, decideAuth)
      expect(read.status).toBe(403)
      const write = await app.call(
        'PUT',
        ENDPOINT,
        { url: 'https://hooks.example.com/cat-factory' },
        decideAuth,
      )
      expect(write.status).toBe(403)
      expect((await app.call('DELETE', ENDPOINT, undefined, decideAuth)).status).toBe(403)
      expect((await app.call('GET', ENDPOINT)).status).toBe(401)

      // Two layers refuse a bad endpoint and they answer differently, which is worth pinning
      // rather than papering over with an "any 4xx" range. The wire schema catches plaintext
      // before the handler runs (400); the SSRF guard inside the SERVICE catches a private host
      // (422, a thrown `ValidationError` through the shared error funnel). The second is the one
      // that matters here: it is the same guard the delivery path re-applies on every redirect
      // hop, so the public surface cannot admit an endpoint deliveries would then refuse.
      const adminAuth = await mintKey(app, wsId, 'admin')
      const plaintext = await app.call(
        'PUT',
        ENDPOINT,
        { url: 'http://hooks.example.com/cat-factory' },
        adminAuth,
      )
      expect(plaintext.status).toBe(400)
      const internal = await app.call('PUT', ENDPOINT, { url: 'https://127.0.0.1/hook' }, adminAuth)
      expect(internal.status).toBe(422)
      const nothingStored = await app.call<PublicNotificationWebhook>(
        'GET',
        ENDPOINT,
        undefined,
        adminAuth,
      )
      expect(nothingStored.body.webhook).toBeNull()
    })

    it("scopes the endpoint to the KEY's workspace, never a neighbour's", async () => {
      const app = harness.makeApp()
      const { workspace: mine } = await app.createOrgWorkspace({ seed: true })
      const { workspace: theirs } = await app.createOrgWorkspace({ seed: true })
      const mineAuth = await mintKey(app, mine.id, 'admin')
      const theirsAuth = await mintKey(app, theirs.id, 'admin')

      const saved = await app.call<NotificationWebhook>(
        'PUT',
        ENDPOINT,
        { url: 'https://hooks.example.com/mine' },
        mineAuth,
      )
      expect(saved.status).toBe(200)

      // There is no workspace id on the path to get wrong, which is exactly why this is worth
      // pinning: the routes read it off the authenticated key, so a facade that resolved it from
      // anything else would cross boards with no visible parameter to blame.
      const theirsRead = await app.call<PublicNotificationWebhook>(
        'GET',
        ENDPOINT,
        undefined,
        theirsAuth,
      )
      expect(theirsRead.body.webhook).toBeNull()

      const theirsDelete = await app.call('DELETE', ENDPOINT, undefined, theirsAuth)
      expect(theirsDelete.status).toBe(204)
      const mineRead = await app.call<PublicNotificationWebhook>(
        'GET',
        ENDPOINT,
        undefined,
        mineAuth,
      )
      expect(mineRead.body.webhook?.url).toBe('https://hooks.example.com/mine')
    })
  })
}
