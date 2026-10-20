import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { putDirectoryWebhookSchema } from './directory.js'
import { putNotificationWebhookSchema } from './notification-webhooks.js'

// The schemas admit http as well as https so the deployment's URL policy, which runs after them,
// is what decides whether a plaintext endpoint is allowed.
describe.each([
  ['directory', putDirectoryWebhookSchema],
  ['notification', putNotificationWebhookSchema],
])('the %s webhook endpoint', (_, schema) => {
  it.each(['https://hooks.example.com/dir', 'http://localhost:8788/webhooks/x'])(
    'leaves %s to the URL policy',
    (url) => {
      expect(v.safeParse(schema, { url }).success).toBe(true)
    },
  )

  it('refuses any other scheme', () => {
    const result = v.safeParse(schema, { url: 'ftp://hooks.example.com/dir' })
    expect(result.success).toBe(false)
    expect(result.issues?.[0]?.message).toBe(
      'The webhook endpoint must be an http:// or https:// URL',
    )
  })
})
