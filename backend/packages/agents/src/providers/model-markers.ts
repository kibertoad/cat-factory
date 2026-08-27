import { wrapLanguageModel } from 'ai'
import type { LanguageModelMiddleware } from 'ai'
import type { SelfReportingLanguageModel } from './cli-inline.js'
import type { UsageAttributedLanguageModel } from './usage-attribution.js'

// Keeping a resolved model's DECLARATIONS alive across the middleware wraps applied above it.
//
// A `ModelProvider` decorator wraps the model it resolved with an AI SDK middleware, and
// `wrapLanguageModel` does NOT return the model: it returns a fresh object carrying only the six
// `LanguageModelV3` members it knows about (`specificationVersion`, `provider`, `modelId`,
// `supportedUrls`, `doGenerate`, `doStream`). Every other property the model declared is gone,
// silently, with the call behaviour intact.
//
// That is fatal for the markers, because a marker exists PRECISELY to be read by a layer above
// the one that resolved it. `wrapResolverWithTelemetry` composes the facade wrap, then the
// instrumentation, then the concurrency limiter, and only the last of those is what
// `AiAgentExecutor` holds. So a marker declared by local mode's `CliInlineLanguageModel` reached
// its reader only while every wrap between them happened to be inert: the limiter caps the five
// subscription vendors at 3 inline calls by DEFAULT, so on the deployment this was built for the
// model that came back was a wrapper and the step filed as metered again.
//
// Wrapping through {@link wrapModelPreservingMarkers} re-declares them on the wrapper, so a
// marker means the same thing however many decorators sit above the model that declared it.

/**
 * Every declaration a resolved model may carry for a LATER layer to read.
 *
 * One list rather than a marker per file, because the property that matters about them is
 * shared and easy to miss: each is written by the provider chain and read above it, so each
 * has to survive the wraps in between. A second marker was added as a plain property and was
 * erased by the wrap the first one happened to escape.
 *
 * The interfaces themselves stay with the concepts they belong to
 * ({@link SelfReportingLanguageModel}, {@link UsageAttributedLanguageModel}); this is where
 * they are bound together as things a wrap must carry.
 */
export interface ModelMarkers
  extends Partial<SelfReportingLanguageModel>, Partial<UsageAttributedLanguageModel> {}

/** The marker properties {@link wrapModelPreservingMarkers} carries onto a wrapper. */
const MODEL_MARKER_KEYS = ['reportsOwnLlmCalls', 'usageAttribution'] as const

/**
 * Adding a marker to {@link ModelMarkers} without listing it above fails to compile here, so a
 * new marker cannot ship as one the first decorator above it silently drops. The expected type
 * spells the offending key out, so the error says which marker is unlisted rather than only
 * that one is.
 */
type UnlistedMarker = Exclude<keyof ModelMarkers, (typeof MODEL_MARKER_KEYS)[number]>
const _allMarkersListed: [UnlistedMarker] extends [never]
  ? true
  : `unlisted model marker: ${UnlistedMarker}` = true
void _allMarkersListed

/**
 * `wrapLanguageModel`, with the source model's {@link ModelMarkers} re-declared on the wrapper.
 *
 * Use this for EVERY `ModelProvider` decorator's wrap. Reaching for `wrapLanguageModel`
 * directly compiles, behaves identically for the call itself, and quietly breaks whichever
 * layer above was reading a marker.
 *
 * Only markers the source actually declares are copied, so a wrapped plain provider model stays
 * a model that declares nothing rather than one declaring `undefined`.
 */
export function wrapModelPreservingMarkers({
  model,
  middleware,
}: {
  model: Parameters<typeof wrapLanguageModel>[0]['model']
  middleware: LanguageModelMiddleware
}): ReturnType<typeof wrapLanguageModel> {
  const wrapped = wrapLanguageModel({ model, middleware })
  const source = model as ModelMarkers
  for (const key of MODEL_MARKER_KEYS) {
    if (!(key in source)) continue
    Object.defineProperty(wrapped, key, {
      value: source[key],
      enumerable: true,
      writable: false,
      configurable: true,
    })
  }
  return wrapped
}
