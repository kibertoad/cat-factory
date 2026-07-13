import { DOCS } from '../config/docs.js'
import { logger } from '../observability/logger.js'

// ---------------------------------------------------------------------------
// Webhook signature-rejection operator logging (error-message coverage C2).
//
// Both webhook receivers — GitHub's dedicated `/github/webhooks` (HMAC over the raw body via
// `X-Hub-Signature-256`) and the neutral `/vcs/:provider/webhooks` (GitLab's caller-chosen
// `X-Gitlab-Token`) — reject a delivery that fails verification with a deliberately TERSE
// 401 `Invalid signature`. That response is correct: the caller is an external system (GitHub /
// GitLab), not the operator, so it must not leak why. But a mismatched webhook secret is a
// CLASSIC self-host setup error, and the terse 401 tells the operator watching the logs nothing.
//
// So the response stays terse while we LOG one elaborate, operator-facing warning naming the
// likely cause (the deployment secret and the provider-side secret differ, or one is unset) and
// exactly where to compare the two. It carries no secret material — only which env var to set and
// which provider settings field to compare it against. Mirrors the boot-warning shape of the A7
// Redis probe / A12 PAT probe: a single structured `logger.warn` line with a doc link.
// ---------------------------------------------------------------------------

/** Which webhook route rejected the delivery — GitHub (HMAC) or a neutral VCS provider (token). */
export type WebhookSignatureProvider = 'github' | 'gitlab'

export interface WebhookSignatureRejection {
  provider: WebhookSignatureProvider
  /** Whether the deployment has a webhook secret configured for this route/connection. */
  secretConfigured: boolean
  /** Whether the inbound delivery carried the provider's signature/token header at all. */
  signaturePresent: boolean
}

interface ProviderCopy {
  /** Human name of the provider for the warning prose. */
  label: string
  /** The env var that holds this deployment's webhook secret. */
  envVar: string
  /** The signature/token request header the provider sends. */
  header: string
  /** The provider-side field to compare the secret against + where to find it. */
  providerSecretField: string
  /** The doc URL deepening the remedy. */
  docsUrl: string
}

const PROVIDER_COPY: Record<WebhookSignatureProvider, ProviderCopy> = {
  github: {
    label: 'GitHub',
    envVar: 'GITHUB_WEBHOOK_SECRET',
    header: 'X-Hub-Signature-256',
    providerSecretField: "the GitHub App's 'Webhook secret' (App settings → Webhook)",
    docsUrl: DOCS.githubIntegration('authentication'),
  },
  gitlab: {
    label: 'GitLab',
    envVar: 'GITLAB_WEBHOOK_SECRET',
    header: 'X-Gitlab-Token',
    providerSecretField: "the webhook's 'Secret token' (GitLab project/group Settings → Webhooks)",
    docsUrl: DOCS.vcsProviders('setup'),
  },
}

/**
 * The operator-facing warning for a rejected webhook delivery, tailored to the failure sub-case:
 *  - no deployment secret configured — every signed delivery fails closed;
 *  - a delivery with no signature header — the provider side has no secret set (or the caller
 *    isn't the provider);
 *  - a signature that did not match — the two secrets differ.
 *
 * Self-sufficient without the doc link; carries no secret material. Exported for unit tests.
 */
export function describeWebhookSignatureRejection(rejection: WebhookSignatureRejection): string {
  const { label, envVar, header, providerSecretField, docsUrl } = PROVIDER_COPY[rejection.provider]
  const lead = `A ${label} webhook delivery was rejected (401 Invalid signature):`

  let cause: string
  if (!rejection.secretConfigured) {
    cause =
      `this deployment has no webhook secret configured (${envVar} is unset), so every ` +
      `delivery fails verification. Set ${envVar} to the same value as ${providerSecretField}.`
  } else if (!rejection.signaturePresent) {
    cause =
      `no ${header} header was present. Either ${providerSecretField} is not set (add one ` +
      `matching ${envVar}) or the caller is not ${label}.`
  } else {
    cause =
      `the signature did not match. ${providerSecretField} and this deployment's ${envVar} ` +
      `differ — set them to the same value.`
  }

  return `${lead} ${cause} See ${docsUrl}.`
}

/**
 * Log the {@link describeWebhookSignatureRejection} warning for a rejected delivery. The HTTP
 * response stays a terse 401 to the external caller; this makes the setup error visible to the
 * operator in the logs. The `provider` doubles as a structured field for log filtering.
 */
export function logWebhookSignatureRejection(rejection: WebhookSignatureRejection): void {
  logger.warn(
    { provider: rejection.provider, event: 'webhook_signature_rejected' },
    describeWebhookSignatureRejection(rejection),
  )
}
