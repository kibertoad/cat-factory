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
// — discovery, parameter validation, model narrowing, the budget guard, the refusals — be driven
// on every runtime with no model wired.
// ---------------------------------------------------------------------------

/** Whether this deployment can serve one declared model option for a workspace, and why not. */
export type InlineUseCaseModelAvailability =
  | { available: true; ref: ModelRef }
  | { available: false; reason: UseCaseModelUnavailableReason }

/** One generation request: everything the call needs, already validated and clamped. */
export interface InlineUseCaseGenerationRequest {
  /** The workspace the invoking key belongs to (the credential scope AND the telemetry tag). */
  workspaceId: string
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
  /** What the provider billed. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** The ref the call actually ran on, so the response can attribute the text. */
  ref: ModelRef
}

/**
 * Resolves and runs the model call behind an inline use case.
 *
 * `enabled` is false when the deployment wired no model provider at all. The invocation surface
 * refuses with a 503 naming that, rather than reporting every declared model as unavailable: an
 * unconfigured deployment and a deployment missing one vendor's key are different facts, and only
 * the first is answered by "wire a model provider".
 */
export interface InlineUseCaseGenerator {
  /** Whether a generation can run at all (a model provider is wired). */
  readonly enabled: boolean
  /** Whether an invocation naming `option` could run right now, for this workspace. */
  availability(
    workspaceId: string,
    option: InlineUseCaseModelOption,
  ): Promise<InlineUseCaseModelAvailability>
  /** Run the call. Throws when the model is unreachable or answers unusably. */
  generate(request: InlineUseCaseGenerationRequest): Promise<InlineUseCaseGeneration>
}
