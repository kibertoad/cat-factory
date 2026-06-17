import type { WebhookVerifier } from '@cat-factory/kernel'

/** Webhook verifier whose result is toggled by tests. */
export class FakeWebhookVerifier implements WebhookVerifier {
  constructor(public result = true) {}
  async verify(): Promise<boolean> {
    return this.result
  }
}
