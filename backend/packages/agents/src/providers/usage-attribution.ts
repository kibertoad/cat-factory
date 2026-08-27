import type { UsageBilling } from '@cat-factory/kernel'

// How a RESOLVED model states the credential it was built on, so the spend ledger records the
// billing kind wherever the call was made from.
//
// The container executor could answer this at its dispatch site, because it resolves the
// subscription credential itself. The inline path cannot: `AiAgentExecutor` asks a
// `ModelProvider` for a model and never learns which credential served it, so every inline
// step defaulted to `'metered'` with no vendor — including the kinds that ran on the very same
// subscription the containerised steps were correctly tagged with (a run's `architect` filed
// as subscription while its `architect-companion`, one credential and one process apart, filed
// as metered spend that no card was ever charged for).
//
// So the answer travels ON THE MODEL, from the provider that resolved the credential to the
// executor that reports the usage, exactly like `reportsOwnLlmCalls` travels from the same
// place to the instrumentation middleware. A model that says nothing is metered, which is what
// a direct provider key is.

/** The billing attribution of one resolved model: what pays for its calls, and to whom. */
export interface UsageAttribution {
  billing: UsageBilling
  /**
   * The vendor the credential belongs to, as the model ref's PROVIDER slug (`anthropic`,
   * `openai`), which is what the container path records for the same run. Never empty: a
   * subscription row whose vendor is blank cannot be grouped or reconciled against anything.
   */
  vendor: string
}

/**
 * A `LanguageModelV3` that knows how its calls are billed because it was built on the
 * credential that serves them.
 *
 * Declared as a marker the EXECUTOR reads rather than a flag a facade sets, for the same reason
 * `SelfReportingLanguageModel` is: the credential is resolved deep inside a per-scope
 * provider chain, and the executor that reports the usage holds only the model that came back.
 */
export interface UsageAttributedLanguageModel {
  readonly usageAttribution: UsageAttribution
}

/**
 * The billing attribution `model` declares, or `undefined` when it declares none (a plain
 * metered provider key, whose calls are billed per token by the vendor's API).
 *
 * A declared attribution with a blank vendor is treated as no declaration at all: the pair only
 * means anything together, and half of it would file a subscription row nothing can group.
 */
export function usageAttributionOf(model: unknown): UsageAttribution | undefined {
  const declared = (model as UsageAttributedLanguageModel | null)?.usageAttribution
  if (!declared?.vendor.trim()) return undefined
  return declared
}
