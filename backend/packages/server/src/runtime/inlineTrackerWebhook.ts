import type { TrackerWebhookIngest } from './gateways.js'

/**
 * The "no async consumer wired" {@link TrackerWebhookIngest}: report NOT queued so the receiver
 * applies the delivery inline.
 *
 * Shared by every facade rather than re-declared per runtime, because unlike the GitHub-sync
 * seams there is nothing runtime-specific about doing nothing — and a second copy is a second
 * place for the boolean to be wrong. A facade with a real queue supplies its own implementation;
 * one without (a pure-logic test container, a local dev boot with no queue binding) supplies this,
 * which keeps the fallback an explicit choice rather than a missing field.
 */
export class InlineTrackerWebhookIngest implements TrackerWebhookIngest {
  enqueueEvent(): Promise<boolean> {
    return Promise.resolve(false)
  }
}
