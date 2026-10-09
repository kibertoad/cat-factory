// `@cat-factory/webhooks`: verify a cat-factory outbound webhook delivery before trusting it. Every
// delivery the platform sends (notification, run lifecycle, platform health, directory) is signed
// the same way, so one verifier serves them all.

export { DEFAULT_MAX_SKEW_MS, type VerificationResult, verifyDelivery } from './signature.ts'
export { type VerifiedRequest, verifyRequest } from './request.ts'
