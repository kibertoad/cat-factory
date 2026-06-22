// The webhook verifier is runtime-neutral and now lives in @cat-factory/server so
// every facade verifies GitHub deliveries identically. Re-exported here to keep this
// module's existing import path stable for the Worker infra.
export { WebCryptoWebhookVerifier } from '@cat-factory/server'
