import type { UseCaseFinishReason, UseCaseModelUnavailableReason } from '@cat-factory/contracts'
import type { InlineUseCaseModelOption } from '../domain/inline-use-case-registry.js'
import type { ModelRef } from './model-provider.js'

// ---------------------------------------------------------------------------
// The producer behind an inline use case: the one seam that resolves a declared model option and
// runs the model call.
//
// Its own port, rather than the service calling `generateText` directly, for the reason the judge
// assessor and the bug-hunt assessor have one: it is the only part of the feature that needs a
// real provider, so a deterministic fake behind this interface lets the whole rest of the surface
// (discovery, parameter validation, model narrowing, the budget guard, the refusals) be driven on
// every runtime with no model wired.
//
// The seam is TWO interfaces rather than one, and the split is the load-bearing part: resolving a
// credential scope is not free. It reads the workspace's owning account, the configured providers
// and then LEASES a key per provider (an atomic select-and-mark write plus a secret decrypt), so a
// generator whose every method took a workspace id turned one discovery read into that fan-out per
// declared model option: a read-scope `GET` doing lease WRITES, once per option, whose usage stamps
// then skew the very key rotation they never spent a token on. {@link InlineUseCaseGenerator} is
// therefore bound ONCE per request through `forScope`, and the returned {@link InlineUseCaseSession}
// answers every availability probe and the generation itself off that one resolution.
// ---------------------------------------------------------------------------

/**
 * The credential scope one request resolves its models under.
 *
 * All THREE tiers, because all three carry keys: the account's, the workspace's, and the personal
 * keys (plus locally-run model endpoints) of the user an API key acts as. A resolution given the
 * workspace alone reports a model the deployment CAN serve as `provider_unavailable`, which sends
 * an operator to configure a provider that is already configured.
 */
export interface InlineUseCaseScope {
  /** The workspace the invoking key belongs to (the credential pool AND the telemetry tag). */
  workspaceId: string
  /** The workspace's owning account, whose keys and budget ceiling are also in force. */
  accountId?: string | null
  /** The `usr_*` id the key acts as, so their personal keys and local runners are in the pool. */
  userId?: string | null
}

/** Whether this deployment can serve one declared model option for a scope, and why not. */
export type InlineUseCaseModelAvailability =
  | { available: true; ref: ModelRef }
  | { available: false; reason: UseCaseModelUnavailableReason }

/** One generation request: everything the call needs, already validated and bounds-checked. */
export interface InlineUseCaseGenerationRequest {
  /** The use case being run, recorded as the call's agent kind. */
  useCaseId: string
  /** The model option the caller resolved to. */
  option: InlineUseCaseModelOption
  /** The composed system prompt. */
  system: string
  /** The composed user prompt. */
  prompt: string
  /** Sampling temperature, already inside the use case's declared bounds. */
  temperature: number
  /** Reply budget in tokens, already inside the use case's declared bounds. */
  maxOutputTokens: number
}

/** What one generation produced. */
export interface InlineUseCaseGeneration {
  /** The generated text, verbatim. */
  text: string
  /** Why the model stopped, mapped to the bounded wire class. */
  finishReason: UseCaseFinishReason
  /** What the provider billed. `inputTokens` includes both cache classes. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** The ref the call actually ran on, so the response can attribute the text. */
  ref: ModelRef
}

/**
 * The generator bound to ONE scope, for ONE request: the credential pool is resolved by
 * `forScope` and every answer here reads it.
 *
 * `availability` is therefore SYNCHRONOUS, which is not a convenience: it is the type stating that
 * probing an option costs no I/O, so the discovery fan-out over a catalog's options cannot quietly
 * become a fan-out of reads and lease writes again.
 */
export interface InlineUseCaseSession {
  /** Whether an invocation naming `option` could run right now, under this scope. */
  availability(option: InlineUseCaseModelOption): InlineUseCaseModelAvailability
  /** Run the call. Throws when the model is unreachable or answers unusably. */
  generate(request: InlineUseCaseGenerationRequest): Promise<InlineUseCaseGeneration>
}

/**
 * Resolves and runs the model call behind an inline use case.
 *
 * `enabled` is false when the deployment wired no model provider at all. The invocation surface
 * refuses with a 503 naming that, rather than reporting every declared model as unavailable: an
 * unconfigured deployment and a deployment missing one vendor's key are different facts, and only
 * the first is answered by "wire a model provider".
 *
 * `forScope` may THROW (its credential-pool read is a real one). A caller that must answer anyway
 * (discovery) catches it and says so; the invocation path lets it propagate, because "the pool
 * could not be read" is not an availability answer.
 */
export interface InlineUseCaseGenerator {
  /** Whether a generation can run at all (a model provider is wired). */
  readonly enabled: boolean
  /** Bind to one request's credential scope, resolving the provider pool once. */
  forScope(scope: InlineUseCaseScope): Promise<InlineUseCaseSession>
}
