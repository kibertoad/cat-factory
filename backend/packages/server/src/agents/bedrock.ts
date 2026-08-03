// The deployment's AWS Bedrock allow-list, parsed in ONE place because two very different
// consumers must agree on it: `@cat-factory/provider-bedrock`'s resolver (which THROWS on an
// id outside the list) and the model catalog's `bedrock` flavour (which decides what the
// picker offers). Parsed twice, a trailing space or a re-ordered var would offer a route that
// fails at dispatch.

/** The env vars that define Bedrock support, as both facades' env shapes expose them. */
export interface BedrockEnv {
  BEDROCK_REGION?: string | undefined
  BEDROCK_MODELS?: string | undefined
}

/**
 * The AWS Region Bedrock is configured for, trimmed, or `undefined` when unset or blank.
 * "Is Bedrock configured" is asked twice (the Node facade registers the resolver off it; the
 * allow-list below gates on it), so the answer is defined once: a whitespace-only value must
 * not register a resolver the allow-list side treats as absent.
 */
export function bedrockRegionFromEnv(env: BedrockEnv): string | undefined {
  const region = env.BEDROCK_REGION?.trim()
  return region ? region : undefined
}

/**
 * The Bedrock model ids this deployment may call, verbatim and in the operator's declared
 * order (which is how they choose between a regional and a global inference profile for one
 * model: see kernel's `resolveBedrockModelId`). `undefined` when Bedrock contributes no
 * per-model capability, for either of two reasons:
 *
 *  - **No `BEDROCK_REGION`**: the `bedrock` resolver isn't registered at all, so every such
 *    route would fail at dispatch.
 *  - **No `BEDROCK_MODELS`**: the resolver runs UNCONSTRAINED (any id is forwarded to AWS),
 *    which keeps Bedrock reachable as a routing default but leaves the platform nothing to
 *    enumerate. Bedrock access is granted per account and per Region, so guessing that the
 *    catalog's Bedrock entries are callable would offer models AWS rejects at call time. An
 *    operator opts a model into the picker by naming it here.
 */
export function bedrockAllowListFromEnv(env: BedrockEnv): Set<string> | undefined {
  if (!bedrockRegionFromEnv(env)) return undefined
  const models = (env.BEDROCK_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  return models.length ? new Set(models) : undefined
}
