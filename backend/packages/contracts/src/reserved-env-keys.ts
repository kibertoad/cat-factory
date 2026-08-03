// ---------------------------------------------------------------------------
// The environment variable names a DEPLOYMENT'S OWN CONFIGURATION owns, and which a registered
// capability's credential may therefore never name.
//
// The platform already holds one invariant about its environment: it never reaches an agent
// process. A container's environment is COMPOSED (the harness is handed exactly the job body's
// pairs), and the local NATIVE transport — where the harness is a child of the orchestrator and
// would otherwise inherit `process.env` wholesale — projects through the allow-list in
// `runtimes/local/src/childEnv.ts`, whose header names the assets at stake: `DATABASE_URL`,
// `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, `GITHUB_PAT`, the provider API keys.
//
// The `ToolSecretResolver`'s env-backed default is the SECOND path between those two
// environments, and it was the one with no such statement. It reads whatever key a registration
// declares, and a registration names both the key it wants AND the endpoint that key is sent to
// — so `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a valid tool
// server / generative integration that booted clean and shipped the deployment's master sealing
// key into a prompt-injectable agent process. In MOTHERSHIP mode that declaration is authored by
// the mothership and the environment read is a developer's own laptop, which is what turns a
// hygiene problem into a boundary one: `ENCRYPTION_KEY` and `HARNESS_SHARED_SECRET` are the keys
// to the split BETWEEN the two processes, held by the side that is meant to keep them.
//
// So: a capability credential may not name a variable the platform itself reads. Refused where
// the declaration is made (the generative-integration schema, and boot validation for a tool
// server) and again where a declared key becomes a lookup, because a mothership-mode node never
// boot-validates the definitions it resolves — they arrive per dispatch over
// `/internal/binary-generators`, so a check that only ran on the mothership is a check the node
// cannot rely on.
//
// WHY THIS SET IS THE PLATFORM'S WHOLE ENVIRONMENT, not just its secrets. Splitting "secret" from
// "not secret" needs a judgement per variable, and the judgement is wrong the moment a var gains
// a sensitive use — while over-reserving costs a deployment nothing, because nobody names an
// integration credential `PORT`. The provider keys are the case that looks like over-reach and is
// not: `OPENAI_API_KEY` is billable and exfiltratable, and an integration that wants to call
// OpenAI on the deployment's account should say so in its own variable rather than silently
// inherit the one the model router spends.
//
// WHY NOT A PREFIX MANDATE ON THE OTHER SIDE (`GEN_…` / `TOOL_…` for every credential, so the
// platform's names are excluded by construction). It reads as the sounder positive rule and it is
// not available here: a subject credential's `key` is not only what the resolver is asked for, it
// is the ENVIRONMENT VARIABLE NAME the agent reads the value from. Mandating a prefix renames the
// variable inside the agent's process, so an integration whose SDK auto-reads its vendor's
// documented name stops working, and every deployment renames its `.env` to buy it. The same
// positive rule applied to the side that ALREADY has a namespace — the platform's own vars, which
// really do cluster into families — costs nobody a rename and is what {@link
// PLATFORM_RESERVED_ENV_PREFIXES} is.
//
// This lives in `@cat-factory/contracts` because it is the only layer every enforcement point can
// see: the valibot credential schema here, kernel's capability types, the server's dispatch-time
// resolution, and orchestration's boot validation.
// ---------------------------------------------------------------------------

/**
 * Name PREFIXES the platform's own configuration owns (compared case-insensitively).
 *
 * These carry the drift protection: a variable added inside one of these families is reserved the
 * day it is read, with no edit here. `scripts/check-reserved-env-keys.mjs` fails CI when a
 * variable documented in `docs/environment-variables.md` is covered by neither this list nor
 * {@link PLATFORM_RESERVED_ENV_KEYS}, so the exact-name list below cannot silently fall behind
 * either.
 */
export const PLATFORM_RESERVED_ENV_PREFIXES: readonly string[] = [
  'AGENT_',
  'AUTH_',
  'AWS_',
  'BEDROCK_',
  'BUDGET_',
  'CI_',
  'CLOUDFLARE_',
  'CONSENSUS_',
  'CONTAINER_',
  'CORS_',
  'DB_',
  'DECISION_',
  'EMAIL_SYSTEM_',
  'ENVIRONMENTS_',
  'EXECUTION_',
  'GITHUB_',
  'GITLAB_',
  'GOOGLE_OAUTH_',
  'INFRA_REACHABILITY_',
  'INLINE_WEB_SEARCH_',
  'JOB_',
  'LANGFUSE_',
  'LITELLM_',
  'LLM_',
  'LOCAL_',
  'NOTIFICATION_WEBHOOK_',
  'OBSERVABILITY_',
  'OPENROUTER_',
  'OTEL_',
  'PLATFORM_ALERTS_',
  'REDIS_',
  'RUNNERS_',
  'SLACK_',
  'STALE_RUN_',
  'TOKEN_USAGE_',
  'WEB_SEARCH_',
]

/**
 * The platform's own variables that no {@link PLATFORM_RESERVED_ENV_PREFIXES} family covers —
 * every remaining name read by a facade's config loader, a sweeper, or a model provider.
 *
 * Upper-case by convention; the comparison in {@link isReservedPlatformEnvKey} is
 * case-insensitive, which is load-bearing rather than tidy: `process.env` lookup is
 * case-INSENSITIVE on Windows, so a declaration spelled `encryption_key` would otherwise resolve
 * the real key on a developer's laptop while passing a case-sensitive check.
 */
export const PLATFORM_RESERVED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'APP_BASE_URL',
  'DATABASE_URL',
  'DEEPSEEK_API_KEY',
  'ENCRYPTION_KEY',
  'ENVIRONMENT',
  'HARNESS_SHARED_SECRET',
  'HOST',
  'LOG_LEVEL',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'PORT',
  'PUBLIC_URL',
  'QWEN_API_KEY',
  'REALTIME_NODE_ID',
  'WORKER_PUBLIC_URL',
]

const RESERVED = new Set(PLATFORM_RESERVED_ENV_KEYS.map((key) => key.toUpperCase()))
const RESERVED_PREFIXES = PLATFORM_RESERVED_ENV_PREFIXES.map((prefix) => prefix.toUpperCase())

/**
 * Whether `key` names a variable the platform's own configuration owns — so a tool server or a
 * generative integration declaring it is refused rather than resolved.
 *
 * Case-insensitive and whitespace-tolerant, because both are ways the same variable is reached:
 * see {@link PLATFORM_RESERVED_ENV_KEYS} on Windows, and the schema trims before it validates.
 */
export function isReservedPlatformEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase()
  if (!upper) return false
  if (RESERVED.has(upper)) return true
  return RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/**
 * The one operator-facing sentence every refusal of a reserved key uses — the schema issue, the
 * boot problem, and the dispatch-time log line alike.
 *
 * Shared so the three cannot describe the same fault three ways, and phrased as the REMEDY it is:
 * an operator who reads "reserved" without being told to declare a variable of the integration's
 * own tends to try `allowKeys` next, which cannot widen this floor.
 */
export function reservedEnvKeyMessage(key: string): string {
  return (
    `"${key}" is an environment variable the platform's own configuration owns, so it cannot be a ` +
    `capability credential: its value would be read off the deployment's environment and injected ` +
    `into an agent process. Declare a variable of the integration's own (e.g. ` +
    `"ACME_IMAGE_API_KEY") and set it beside the platform's.`
  )
}
