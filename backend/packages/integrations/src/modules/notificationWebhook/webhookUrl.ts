import type { UrlSafetyPolicy } from '@cat-factory/kernel'
import { assertSafePublicUrl } from '../shared/url-guard.js'

// The notification-webhook face of the shared SSRF guard. Applied in BOTH places a URL can enter
// the system, which is the point:
//
//  - the WRITE boundary (`NotificationWebhookService.put`), so a private/internal endpoint is
//    rejected with a clear message when an operator registers it, not silently at 3am;
//  - every REDIRECT hop of a delivery (`WebhookNotificationChannel` via `safeFetch`), because the
//    write-time check only ever vouched for the FIRST URL and a receiver is free to 302 the
//    delivery — body, signature headers and all — at an internal target.
//
// The contract schema only checks for an `http://` or `https://` prefix, so whether plaintext is
// allowed is decided here, by the deployment's policy.

/**
 * Validate a notification-webhook endpoint. Strict by default — `https` only, no private/internal
 * or cloud-metadata host — widened only by the deployment's own
 * `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `_ALLOW_HTTP_URLS` slice, which a developer running a
 * receiver on `localhost` genuinely needs. Throws `ValidationError`, which `handleError` maps to a
 * 422.
 */
export function assertSafeNotificationWebhookUrl(url: string, policy?: UrlSafetyPolicy): void {
  assertSafePublicUrl(url, {
    subject: 'Notification webhook',
    label: 'endpoint',
    ...(policy ? { policy } : {}),
  })
}
