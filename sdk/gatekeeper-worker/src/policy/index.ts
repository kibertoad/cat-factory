// The POLICY surface: everything a deployment needs to WRITE its policy, and nothing that needs a
// Worker runtime to import.
//
// It is a separate entry point (`@cat-factory/gatekeeper-worker/policy`) for one reason: the
// package's main entry reaches `cloudflare:workers` for the Durable Object, so a policy file that
// imported through it could only be loaded inside workerd. A policy is the one thing an operator
// authors, reviews and tests, and none of those should need a Worker isolate to run.
//
// Everything here is re-exported from the main entry too, so a deployment that does not care can
// import from one place.

export {
  compilePolicy,
  describeBinding,
  tierForActor,
  type CompiledPolicy,
  type CompiledTier,
  type GatekeeperPolicy,
  type TierPolicy,
  type WithheldBinding,
  type WithheldReason,
} from './compile.js'

export {
  ANSWERABLE_DECISION_KINDS,
  answererFor,
  DECISION_BINDINGS,
  DECISION_KEY_SCOPE,
  type DecisionAnswerer,
  type DecisionCall,
  type DecisionField,
  type DecisionVerb,
  type LiveDecision,
  type ParkedDecisionKind,
} from './decisions.js'

// A policy is refused by a `PolicyError` and MASKED paths are the other half of a tier, so both
// belong to the vocabulary a policy file and its tests speak.
export { GatekeeperError, PolicyError, type GatekeeperReason } from '../errors.js'
export { applyMask, MASKED } from '../masking.js'

// Re-exported rather than re-declared: a policy names operations and scopes, and the table it
// names them from is the generated one, so a deployment should be reading the same types the
// compiler checks its policy against.
export type {
  GatekeeperBinding,
  GatekeeperQueryParam,
  PublicApiScope,
  TelemetrySink,
} from '@cat-factory/gatekeeper-bindings'

// The derived deny set a policy withholds captured run telemetry with. Re-exported rather than
// restated for the same reason `DECISION_BINDINGS` is derived rather than transcribed: a policy
// naming these by hand stops covering the surface the day an operation joins it, and the failure
// is an oversight tier that can read a run's transcript.
export { TELEMETRY_BINDINGS } from '@cat-factory/gatekeeper-bindings'
