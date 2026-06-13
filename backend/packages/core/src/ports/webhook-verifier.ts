// Port for verifying inbound GitHub webhook signatures. GitHub signs each
// delivery with HMAC-SHA-256 over the raw request body using the App's webhook
// secret, sending the digest in the `X-Hub-Signature-256` header. The worker
// implements this with Web Crypto (`crypto.subtle`); modelling it as a port keeps
// the WebhookService free of any crypto/runtime concern and lets tests toggle
// pass/fail with a fake.

export interface WebhookVerifier {
  /**
   * Verify `signatureHeader` (the raw `X-Hub-Signature-256` value, e.g.
   * `sha256=...`) against the raw request body. Returns false for a missing or
   * mismatched signature rather than throwing.
   */
  verify(rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean>
}
