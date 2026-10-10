// ---------------------------------------------------------------------------
// What a registered capability's credential may be NAMED.
//
// A credential has two names and this module holds the rule for each. The LOOKUP name (`key`) is
// what a `ToolSecretResolver` is asked for, so it can reach the deployment's own environment; it
// may not name a variable the platform's own configuration owns, which is the first half below.
// The INJECTED name (`envName`, defaulting to the lookup name) is what the resolved value is set
// as in the agent's or the MCP server's process; it reads nothing, so it is held only to the
// narrower toolchain rule in the second half.
//
// First half: the environment variable names a DEPLOYMENT'S OWN CONFIGURATION owns, and which a
// registered capability's credential may therefore never be looked up by.
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
  'BIFROST_',
  'BUDGET_',
  'CI_',
  'CLOUDFLARE_',
  'CONSENSUS_',
  'CONTAINER_',
  'CORS_',
  'DB_',
  'DECISION_',
  // The deployment's own document-source credentials (`DOC_SOURCE_<SOURCE>_<FIELD>`), which back
  // the living document a code-registered prompt fragment names. A family rather than exact names:
  // the variables are DERIVED from each provider's declared credential fields, so a new source
  // adds variables no list here could have named in advance.
  'DOC_SOURCE_',
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
  // The SERVICE CATALOG (developer-portal) import's own configuration. A family rather than the two
  // exact names, because the platform owns this namespace outright and the alternative is the
  // failure the family rule exists to prevent: the next knob added here would be read by config
  // before anyone remembered to reserve it, and a capability credential could already be looked up
  // under that name.
  'SERVICE_CATALOG_',
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
  // An exact name, not an `ADVANCE_` family, for the reason `MCP_OAUTH_REDIRECT_URL` below is:
  // reserving a prefix is only free where the platform OWNS the namespace, and this one owns a
  // single variable in it. A family here would newly refuse credential keys a deployment may
  // already have registered (`ADVANCE_API_TOKEN` for a vendor called Advance), which is a
  // capability taken away from a live integration to protect one name.
  'ADVANCE_TIMEOUT',
  'ANTHROPIC_API_KEY',
  // The per-vendor `${VENDOR}_BASE_URL` overrides, alongside each vendor's key below. Exact names
  // rather than a `QWEN_` / `DEEPSEEK_` / … family, for the reason `ADVANCE_TIMEOUT` above gives:
  // reserving a namespace is only free where the platform owns the whole of it, and it owns two
  // variables in each of these. They belong here because the platform READS them by name at
  // dispatch (Node resolves `${PROVIDER}_BASE_URL` off its own env for any provider id, and the
  // Worker maps a typed field per provider), which is the whole test for this list: the set is the
  // platform's environment, not just its secrets.
  'ANTHROPIC_BASE_URL',
  'APP_BASE_URL',
  'AUDIT_EVENT_RETENTION_DAYS',
  'DATABASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'ENCRYPTION_KEY',
  'ENVIRONMENT',
  'GATE_OUTCOME_RETENTION_DAYS',
  'HARNESS_SHARED_SECRET',
  'HOST',
  'LOG_LEVEL',
  // Deliberately an EXACT name and not an `MCP_` family. The docs recommend `MCP_…` as the prefix
  // a deployment keeps its tool-server CREDENTIALS behind, so reserving the family would make the
  // recommended convention unusable; reserving this one name costs a deployment nothing, because
  // nobody names a credential after a redirect URL, and it is refused loudly at boot if anyone does.
  'MCP_OAUTH_REDIRECT_URL',
  'MOONSHOT_API_KEY',
  'MOONSHOT_BASE_URL',
  // Exact names rather than a `NOTIFICATION_` / `PROVISIONING_` family, for the same reason as
  // `ADVANCE_TIMEOUT`: each family holds one platform variable, and reserving the whole namespace
  // would newly refuse credential keys a deployment may already have registered under it.
  'NOTIFICATION_RETENTION_DAYS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PLATFORM_RUN_DAY_RETENTION_DAYS',
  'PORT',
  'PROVISIONING_LOG_RETENTION_DAYS',
  'PUBLIC_URL',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'REALTIME_NODE_ID',
  'WORKER_PUBLIC_URL',
  // Exact names rather than an `XAI_` family, for the same reason as `ADVANCE_TIMEOUT`: the
  // platform owns two variables in that namespace, and reserving the family would newly
  // refuse a credential key a deployment may already hold under it.
  'XAI_API_KEY',
  'XAI_BASE_URL',
]

const RESERVED = new Set(PLATFORM_RESERVED_ENV_KEYS.map((key) => key.toUpperCase()))
const RESERVED_PREFIXES = PLATFORM_RESERVED_ENV_PREFIXES.map((prefix) => prefix.toUpperCase())

/**
 * Whether `key` names a variable the platform's own configuration owns, so a tool server or a
 * generative integration declaring it is refused rather than resolved.
 *
 * Binds the LOOKUP name only: the name a resolver is asked for, and therefore the name that could
 * be read off the deployment's environment. It deliberately does NOT bind the name a resolved
 * value is injected UNDER in the agent's process ({@link isToolchainEnvName} is that rule), and
 * conflating the two is what makes a family like `GITHUB_` unusable for the third-party servers
 * that legitimately own names inside it.
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
    `"${key}" is an environment variable the platform's own configuration owns, so it cannot be ` +
    `the key a capability credential is looked up by: its value would be read off the deployment's ` +
    `environment and injected into an agent process. Look the credential up under a name of the ` +
    `integration's own (e.g. "ACME_IMAGE_API_KEY"); if the process reading it needs a specific ` +
    `variable name, set "envName" to that name, which is not held to this list.`
  )
}

// ---------------------------------------------------------------------------
// The OTHER half of the rule: names a resolved value may not be INJECTED under.
//
// A credential has two names, and only the first is a boundary. The LOOKUP name is what a
// resolver is asked for, so it can reach the platform's own environment: that one is held to
// `isReservedPlatformEnvKey` above. The INJECTED name is what the value is set as in the agent's
// (or the MCP server's) process, and it reads nothing at all, so the reserved list must not bind
// it. It has its own, narrower rule: a name that RECONFIGURES the process instead of
// authenticating a call.
//
// Keeping them apart is what makes both rules affordable. An `http` tool server has always had the
// split (`key` is the lookup, `header` is where the value goes), and it is the stdio and
// generative-integration cases that conflated them: with one name, reserving the `GITHUB_` family
// also reserved `GITHUB_PERSONAL_ACCESS_TOKEN`, which the platform does not read and the GitHub
// MCP server requires. Renaming it is not open to a deployment either, since the server's own SDK
// reads its documented name, which is exactly the argument against mandating a `TOOL_` prefix on
// the lookup side.
// ---------------------------------------------------------------------------

/**
 * Toolchain-critical names, which must never be injected into an agent's environment because
 * doing so reconfigures the process rather than authenticating a call: the loader and search
 * paths, the shell's own hooks, npm's and git's config families.
 *
 * The harness carries its own copy (`RESERVED_ENV_NAMES` in `job.ts`) and drops these
 * defensively at parse, because the image builds from `src/` plus typescript and can depend on no
 * workspace package. That copy stays a pinned-by-convention duplicate. This one is shared across
 * the declaration surfaces INSIDE contracts (the stored credential, the tool-server registration,
 * the generative-integration schema) rather than copied per surface, because refusing at the write
 * boundary is what turns "silently never injected" into an error while the operator is typing.
 */
const TOOLCHAIN_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
])
const TOOLCHAIN_ENV_PREFIXES = ['npm_config_', 'git_']

/** Whether `name` is a toolchain variable, so injecting a value under it would reconfigure the run. */
export function isToolchainEnvName(name: string): boolean {
  const trimmed = name.trim()
  if (TOOLCHAIN_ENV_NAMES.has(trimmed)) return true
  const lower = trimmed.toLowerCase()
  return TOOLCHAIN_ENV_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** The one operator-facing sentence every refusal of a toolchain injection name uses. */
export function toolchainEnvNameMessage(name: string): string {
  return (
    `"${name}" is a toolchain environment variable, so a credential injected under it would ` +
    `reconfigure the agent's process instead of authenticating a call. Use the name the ` +
    `integration's own client reads (e.g. "ACME_API_KEY").`
  )
}

/** Whether `name` is shaped like an environment variable at all. */
export function isEnvVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}
