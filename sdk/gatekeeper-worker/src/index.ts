// `@cat-factory/gatekeeper-worker`: the Gatekeeper machinery a deployment INSTALLS, as opposed to
// the policy and the wiring it WRITES (`deploy/gatekeeper` is the template for those).
//
// The split is what makes an upgrade a dependency bump. Everything here is deployment-neutral: the
// Cap'n Web capability surface, the per-actor key broker, the delivery receiver and its verifier,
// the approval inbox and the per-park answerers, the Durable Object all four keep their state in.
// What is NOT here is the one thing that differs per deployment, the policy, which arrives as an
// argument to `createGatekeeperWorker`.

export { createGatekeeperWorker, type GatekeeperWorkerOptions } from './worker.js'
export { Gatekeeper, type DeliveryOutcome } from './gatekeeper.js'

// The Durable Object class. A deployment re-exports it from its own entry module, because
// wrangler's `class_name` binding resolves against the Worker's exports, not this package's.
export {
  GatekeeperState,
  type ApprovalCard,
  type DeliveryApplication,
  type DeliveryEffect,
  type MintClaim,
  type MintTicket,
  type RunState,
  type StoredKey,
} from './state.js'

export { ConfigError, type GatekeeperEnv } from './env.js'
export {
  buildCapability,
  type CardInspection,
  type SessionDependencies,
  type TierSummary,
} from './capability.js'
export { KeyBroker, type Actor, type KeyBrokerDependencies, type LeasedClient } from './keys.js'

export {
  answerCard,
  assertAnswerable,
  describeStale,
  pendingParks,
  type AnswerInput,
  type AnswerOutcome,
  type BindingInvoker,
  type DecisionListShape,
  type PendingPark,
} from './approvals.js'

export {
  cardEffectOf,
  dispositionOf,
  PARKED_DECISION_CARD_TYPES,
  readDelivery,
  SUBSCRIBED_CARD_TYPES,
  type CardDisposition,
  type Delivery,
} from './webhook/delivery.js'
export {
  DEFAULT_MAX_SKEW_MS,
  verifyDelivery,
  type VerificationResult,
} from './webhook/signature.js'

// The policy vocabulary, also reachable on its own at `@cat-factory/gatekeeper-worker/policy` for
// a policy file that should not have to load a Worker runtime to be read or tested.
export * from './policy/index.js'
