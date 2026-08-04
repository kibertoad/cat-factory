import type { NotificationWebhookRecord, NotificationWebhookRepository } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { NotificationWebhookService } from './NotificationWebhookService.js'

// The management half of the webhook. Two things here are easy to get wrong and expensive when
// wrong: the write-boundary SSRF guard (an internal endpoint accepted here is a signed POST at an
// internal host later) and keep-on-omit, which holds for EVERY field. Both of its edges are silent
// when broken. Dropping an omitted `secret` un-signs every future delivery, which looks fine right
// up until a receiver starts rejecting; re-defaulting an omitted `url` would point the workspace
// somewhere else entirely, and the tool that did it still answers 200.

const cipher = {
  encrypt: async (plaintext: string) => `sealed:${plaintext}`,
  decrypt: async (envelope: string) => envelope.replace(/^sealed:/, ''),
}
const clock = { now: () => 1_700_000_000_000 }

function repo(initial: NotificationWebhookRecord | null = null): NotificationWebhookRepository & {
  stored: () => NotificationWebhookRecord | null
} {
  let record = initial
  return {
    get: async () => record,
    put: async (next) => {
      record = next
    },
    delete: async () => {
      record = null
    },
    stored: () => record,
  }
}

function service(store: NotificationWebhookRepository, widened = false) {
  return new NotificationWebhookService({
    notificationWebhookRepository: store,
    secretCipher: cipher,
    clock,
    ...(widened
      ? { urlSafetyPolicy: { schemes: ['https', 'http'], allowHosts: ['localhost'] } }
      : {}),
  })
}

describe('NotificationWebhookService', () => {
  it('rejects a private, internal or cloud-metadata endpoint at the write boundary', async () => {
    const svc = service(repo())
    for (const url of [
      'https://169.254.169.254/hook',
      'https://10.0.0.5/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
    ]) {
      await expect(svc.put('ws1', { url }), url).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('rejects an endpoint carrying embedded credentials', async () => {
    // They would be sent on every delivery and shown back in the projection.
    await expect(
      service(repo()).put('ws1', { url: 'https://user:pass@example.test/hook' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('accepts an internal endpoint only when the deployment widened its own policy', async () => {
    const strict = repo()
    await expect(
      service(strict).put('ws1', { url: 'http://localhost:9000/hook' }),
    ).rejects.toBeInstanceOf(ValidationError)

    const widened = repo()
    await expect(
      service(widened, true).put('ws1', { url: 'http://localhost:9000/hook' }),
    ).resolves.toMatchObject({ url: 'http://localhost:9000/hook' })
  })

  it('accepts an ordinary public https endpoint and never reads the secret back', async () => {
    const store = repo()
    const saved = await service(store).put('ws1', {
      url: 'https://example.test/hook',
      secret: 'a-signing-secret-1234',
    })
    expect(saved.hasSecret).toBe(true)
    expect(saved).not.toHaveProperty('secret')
    // Sealed at rest — the plaintext never reaches the row.
    expect(store.stored()!.secretSealed).toBe('sealed:a-signing-secret-1234')
  })

  it('keeps the stored secret when a later put omits one', async () => {
    const store = repo()
    const svc = service(store)
    await svc.put('ws1', { url: 'https://example.test/hook', secret: 'a-signing-secret-1234' })
    // Editing only the type filter must not silently un-sign every future delivery.
    const updated = await svc.put('ws1', {
      url: 'https://example.test/hook',
      types: ['merge_review'],
    })
    expect(updated.hasSecret).toBe(true)
    expect(store.stored()!.secretSealed).toBe('sealed:a-signing-secret-1234')
  })

  it('keeps the registered endpoint when a later put omits the url', async () => {
    const store = repo()
    const svc = service(store)
    await svc.put('ws1', { url: 'https://example.test/hook', secret: 'a-signing-secret-1234' })
    // Subscribing to a new family is a ONE-field write. A mandatory re-send would make this edit
    // carry a url the caller never meant to change, and a stale cached one would redirect every
    // future delivery while looking like it only added a subscription.
    const updated = await svc.put('ws1', { alertEvents: ['platform_health.firing'] })
    expect(updated).toMatchObject({
      url: 'https://example.test/hook',
      alertEvents: ['platform_health.firing'],
      hasSecret: true,
    })
  })

  it('refuses a put that names no url when nothing is registered yet', async () => {
    // Keep-on-omit needs something to keep. The refusal is machine-readable so a client can tell
    // "you must register first" from the SSRF guard's rejection of an endpoint it did supply.
    await expect(service(repo()).put('ws1', { types: ['merge_review'] })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'webhook_url_required' },
    })
  })

  it('leaves a stored endpoint alone when the deployment later narrows its allow-list', async () => {
    // The widened deployment registered a localhost receiver; a later narrowing must not strand
    // the operator, who now needs exactly the edit (disable) that reacts to it. Deliveries stop
    // either way, because the delivery path re-applies the guard per redirect hop.
    const store = repo()
    await service(store, true).put('ws1', { url: 'http://localhost:9000/hook' })
    const narrowed = await service(store).put('ws1', { enabled: false })
    expect(narrowed).toMatchObject({ url: 'http://localhost:9000/hook', enabled: false })
  })
})
