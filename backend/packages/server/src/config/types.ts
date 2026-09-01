import type { AgentRouting, OpenRouterRouting } from '@cat-factory/agents'
import type {
  InfrastructureCapabilities,
  LocalModeConfig,
  ModelFlavor,
  ModelOption,
  PlatformAlertWindow,
  PlatformObservabilityWindow,
} from '@cat-factory/contracts'
import type { DetectionConventions } from '@cat-factory/integrations'
import type { DocumentSourceKind, HarnessKind, ModelRef } from '@cat-factory/kernel'
import type { PlatformAlertThresholds } from '@cat-factory/orchestration'
import type { SpendPricing } from '@cat-factory/spend'

// The resolved application configuration shape, shared by every facade. The values
// are produced per-runtime (the Worker reads them from its `env`, a Node service
// from its process configuration), but the SHAPE is one contract so the controllers
// and middleware in this package can read `container.config.*` regardless of runtime.

export interface AgentsConfig {
  routing: AgentRouting
  /**
   * Resolve a block's selected model id to a concrete ref, honouring the
   * direct/Cloudflare fallback based on which provider keys are configured.
   *
   * `providerPreference` is the route order the model PRESET in force states, folded onto the
   * deployment capabilities this closure was built from. Omitted ⇒ the deployment's default order.
   */
  resolveBlockModel: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  /**
   * Whether this deployment can run a container-only subscription HARNESS ref
   * (`claude-code` / `codex`) as an INLINE LLM call — true only in local mode, where the
   * developer's ambient CLI login is driven as a host subprocess. Passed through to
   * `inlineModelRef` at every inline call site so an ambient-eligible harness ref is KEPT
   * (and served by the harness-aware model provider) instead of degraded to the routing
   * default, and consulted by the preset-satisfiability guard. Undefined on Node/Worker,
   * where inline harness execution is impossible.
   */
  inlineHarnessRef?: (ref: ModelRef) => boolean
}

export interface ExecutionConfig {
  /** Human-decision park timeout passed to the workflow's waitForEvent. */
  decisionTimeout: string
  /** How long the durable driver sleeps between polls of an async container job. */
  jobPollInterval: string
  /** Safety bound on the number of polls before a long-running job is failed. */
  jobMaxPolls: number
  /** How many consecutive status-read failures are tolerated before giving up a job. */
  jobPollFailureTolerance: number
  /** How long the durable driver sleeps between polls of a `ci` step's CI status. */
  ciPollInterval: string
  /** Safety bound on the number of CI polls before the gate is given up. */
  ciMaxPolls: number
  /**
   * Ceiling on ONE `advanceInstance` call or status read, the engine's hang bound. Cloudflare
   * applies it as the `step.do` timeout its durable driver already wrapped both in; Node races
   * the same ceiling in `driveExecution` (pg-boss heartbeats an active job independently of
   * handler progress, so without it a hung HTTP call wedges the run until the queue's expire
   * cap, up to 24h; stuck-run audit F9). ONE knob so the two facades cannot drift apart on the
   * hang bound, which is also why the value arrives here CANONICALISED by the shared
   * `resolveDurationEnv` rather than as whatever the operator typed.
   */
  advanceTimeout: string
  /** Age ceiling for the instance-level container reaper (epoch-ms). */
  containerMaxAgeMs: number
}

export interface PrivilegedAppConfig {
  appId: string
}

export interface GitHubConfig {
  enabled: boolean
  appId: string
  appSlug: string
  apiBase: string
  /** Browser redirect target after a successful connect (falls back to '/'). */
  setupRedirectUrl: string
  /** HMAC secret for signing the install `state` (and verifying webhooks); '' when unset. */
  webhookSecret: string
  /** Present only when a privileged App is configured AND its key is supplied. */
  privilegedApp?: PrivilegedAppConfig
}

/** Google OAuth credentials + (optional) endpoint overrides for "Login with Google". */
export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  /** Explicit redirect_uri; '' means derive `${origin}/auth/google/callback`. */
  redirectUrl: string
  /** OAuth host (authorize/token); defaults to Google's. */
  oauthBase?: string
  /** Userinfo API base; defaults to Google's published `userinfo_endpoint` host. */
  apiBase?: string
}

/**
 * The deployment's OWN identity provider (enterprise SSO), present only when configured.
 *
 * One generic OpenID Connect adapter serves every enterprise IdP — Okta, Entra ID, Auth0,
 * Keycloak, PingFederate, OneLogin, JumpCloud, a Shibboleth IdP with the OIDC OP plugin —
 * because a discovery document plus a client id/secret IS the configuration. There is
 * deliberately no per-vendor field here: a vendor name would only ever be a label.
 *
 * Built by {@link resolveSsoConfig}, which both facades call, so the parsing and every boot
 * refusal live in ONE place rather than being restated per runtime.
 */
export interface SsoConfig {
  /**
   * The issuer / discovery base URL as the operator typed it (`AUTH_SSO_ISSUER_URL`). The
   * DISCOVERED `issuer` is authoritative for everything downstream (the identity subject, the
   * `iss` check); this value only locates the document and keys its cache entry.
   */
  issuerUrl: string
  clientId: string
  clientSecret: string
  /** Operator-supplied sign-in button label. Never localized: it names their IdP. */
  label: string
  /** Space-separated scopes requested. Always contains `openid`. */
  scopes: string
  /** Explicit redirect_uri; '' means derive `${origin}/auth/sso/callback`. */
  redirectUrl: string
  /**
   * Lowercased email domains admitted. EMPTY is the normal, correct state and means the IdP's
   * own app assignment is the whole allowlist — which is the point of SSO, and why this is not
   * fail-closed the way the GitHub login/org lists are: refusing everyone until an operator
   * restates their directory here would defeat the feature they adopted SSO to get.
   */
  allowedEmailDomains: string[]
  /** The claim holding group memberships (`groups` by default; Entra/Shibboleth vary). */
  groupsClaim: string
  /** Lowercased group values admitted. Empty ⇒ no group gate. */
  requiredGroups: string[]
}

export interface AuthConfig {
  /** True when ANY login provider (GitHub OAuth / password / Google / SSO) is configured. */
  enabled: boolean
  /** Local-dev/test ONLY: permit running with auth unconfigured (open API). */
  devOpen: boolean
  /**
   * Test ONLY: run the product with NO authentication at all — the open API of `devOpen`
   * (which this implies) PLUS a signal to the SPA that it may render the board anonymously
   * instead of gating to the login screen. `devOpen` alone keeps the SPA's login gate on a
   * remote facade (a misconfigured/dev-open deployment still has no anonymous tier); this
   * flag is the explicit "there is genuinely no auth here" opt-in the e2e suite uses. Never
   * honoured in a production-like ENVIRONMENT.
   */
  testingNoAuth: boolean
  /** GitHub OAuth is offered only when a client id/secret are set. */
  githubEnabled: boolean
  clientId: string
  clientSecret: string
  sessionSecret: string
  /** REST API base for reading the user (shared with the GitHub integration). */
  apiBase: string
  /** OAuth host (authorize/token endpoints). */
  oauthBase: string
  /** Session token lifetime in milliseconds. */
  sessionTtlMs: number
  /**
   * Machine-token lifetime in milliseconds — the token a mothership mints for a whitelisted
   * mothership-mode node (see `mintMachineToken` / `POST /auth/machine-token`). Longer-lived
   * than a session (the node runs unattended); an expired token means the node re-logs in.
   */
  machineTokenTtlMs: number
  /** Fixed post-login landing URL; '' means honour the request-provided one. */
  successRedirectUrl: string
  /** Explicit OAuth redirect_uri; '' means derive it from the request origin. */
  callbackUrl: string
  /** Lowercased GitHub logins permitted to sign in (OR with allowedOrgs). */
  allowedLogins: string[]
  /** Lowercased GitHub org logins whose members may sign in (OR with allowedLogins). */
  allowedOrgs: string[]
  /** Extra origins the post-login `redirect` query may target, beyond the request origin. */
  allowedRedirectOrigins: string[]
  /** Whether email/password signup + login is offered. */
  passwordEnabled: boolean
  /**
   * Permit password signup WITHOUT an invite or an allowlisted email domain. Local-mode
   * convenience (a single developer creating their own account on their own machine); the
   * Node/Cloudflare facades leave it false so hosted signup stays invite/domain-gated.
   */
  openSignup: boolean
  /** Google OAuth config, present only when configured. */
  google?: GoogleOAuthConfig
  /** Enterprise SSO (generic OIDC) config, present only when configured. */
  sso?: SsoConfig
  /**
   * Lowercased email domains permitted to self-signup (password/Google) without an
   * invite. Empty ⇒ new-user creation is invite-only (the default, fail-closed).
   */
  allowedEmailDomains: string[]
  /**
   * Whether a proxy in front of this process may be believed about the client address.
   * OFF by default on Node: `x-forwarded-for` is attacker-supplied on a bare deployment,
   * and a client-chosen address hands the attacker unlimited fresh throttle buckets plus
   * the ability to pin someone else's (SEC-4). Node deployments behind a proxy opt in with
   * `AUTH_TRUST_PROXY=true`; the Worker hardcodes it on because the Cloudflare edge injects
   * and overwrites `cf-connecting-ip`.
   *
   * WHICH header is consulted is the facade's decision, not this flag's: see each facade's
   * `resolveClientAddress`.
   */
  trustProxyHeaders: boolean
  /**
   * How many trusted proxies sit in front of this process, used to pick the client hop out
   * of an `x-forwarded-for` chain (`AUTH_TRUST_PROXY_HOPS`, default 1). The rightmost entry
   * was appended by the nearest proxy, so with a single proxy the client is last; behind a
   * CDN plus a load balancer it is two from the end. Getting it wrong over-counts (several
   * clients share a bucket) rather than under-counting, because a chain shorter than the
   * declared topology is discarded in favour of the socket peer.
   */
  trustedProxyHops: number
}

export interface EmailConfig {
  /**
   * Opt-in flag. Requires an encryption key (the per-account provider API key is
   * sealed at rest, no plaintext fallback). When false the email module isn't
   * assembled and invitations return a shareable link instead of sending mail.
   * The provider + API key + From address are onboarded per-account in the UI and
   * stored in the DB — NOT read from env — so each org brings its own sender.
   */
  enabled: boolean
  /** Service-level master key (base64) backing provider-API-key encryption at rest. */
  encryptionKey?: string
  /** Public base URL the invite-accept link points at (the SPA origin). */
  appBaseUrl: string
  /**
   * Optional deployment-level "system" sender for auth emails (e.g. password reset),
   * configured entirely via env and independent of the per-account, UI-onboarded
   * connections above. Present only when the provider + From + API key are all set;
   * absent ⇒ reset links are logged (dev) rather than emailed.
   */
  system?: {
    provider: 'sendgrid' | 'resend'
    from: string
    apiKey: string
  }
}

export interface DocumentsConfig {
  /**
   * Always on where the runtime serves documents: there is no enable flag, and an
   * encryption key is mandatory (config load fails loudly without it). False only on
   * facades that do not serve documents at all (e.g. the Node MVP).
   */
  enabled: boolean
  /** Which source providers to register (default: all). */
  sources: DocumentSourceKind[]
  /** 'llm' uses the agent model to plan structure; 'headings' forces the parser. */
  planner: 'llm' | 'headings'
  /** Service-level master key (base64) backing source-credential encryption at rest. */
  encryptionKey?: string
}

export interface TasksConfig {
  /**
   * Always on where the runtime serves task sources: there is no enable flag, and an
   * encryption key is mandatory (config load fails loudly without it).
   */
  enabled: boolean
  /** Service-level master key (base64) backing source-credential encryption at rest. */
  encryptionKey?: string
  // Linear OAuth app credentials are NOT here: like Slack's, they live in per-account
  // deployment settings (sealed in the DB, set in the UI), resolved dynamically at connect
  // time via AccountSettingsService — so an admin can set/rotate them without a redeploy.
}

export interface EnvironmentsConfig {
  /**
   * Service-level master key (base64) backing credential encryption at rest. The
   * module assembles whenever this is present (there is no separate enable flag) — the
   * same "always on where the key is set" model as documents/tasks. Whether a workspace
   * actually provisions anything is governed by whether it registered a connection and
   * whether its pipeline includes a `deployer`/`tester` step, not by a deployment toggle.
   */
  encryptionKey?: string
  /**
   * Hostnames exempt from the strict public-https URL guard, for a TRUSTED in-house
   * adapter pointing at an internal env platform on a private/VPN host. Each entry
   * matches the URL hostname exactly, or as a dot suffix when it starts with `.`
   * (`.internal`). Absent/empty => strict (no exemptions). Folds into the shared
   * {@link UrlSafetyPolicy} via `resolveUrlSafetyPolicy`.
   */
  allowUrlHosts?: string[]
  /** Permit `http` (not just `https`) for trusted provider/env URLs. */
  allowHttpUrls?: boolean
  /**
   * Deployment-level, ADDITIVE extensions to the built-in provisioning-DETECTION conventions, for
   * an org whose repos follow house conventions the defaults don't name. Every field appends to the
   * built-in list (the built-ins always win / stay highest-priority), so it can only make detection
   * find MORE, never remove or change an existing detection. Threaded into the detectors via
   * `CoreDependencies.detectionConventions`. This is the SAME `DetectionConventions` the detectors
   * consume (imported from `@cat-factory/integrations`, an existing dependency of this package), so
   * the two can't drift. Absent ⇒ built-in.
   */
  detectionConventions?: DetectionConventions
}

export interface RunnerPoolConfig {
  /** Opt-in flag. Requires an encryption key (no silent plaintext fallback). */
  enabled: boolean
  /** Service-level master key (base64) backing credential encryption at rest. */
  encryptionKey?: string
  /** Hostnames exempt from the strict public-https URL guard (see EnvironmentsConfig). */
  allowUrlHosts?: string[]
  /** Permit `http` (not just `https`) for a trusted internal pool scheduler URL. */
  allowHttpUrls?: boolean
}

/**
 * The outbound notification-webhook transport. There is no `enabled` flag: like documents/tasks,
 * the feature assembles wherever the shared `ENCRYPTION_KEY` is set (the signing secret must be
 * sealable), and whether anything is delivered is governed by whether a workspace registered an
 * endpoint. Only the URL guard is configurable.
 */
export interface NotificationWebhookConfig {
  /**
   * Hostnames exempt from the strict public-https endpoint guard, for a receiver on an internal /
   * VPN host — or a developer's `localhost` listener. Matches the URL hostname exactly, or as a
   * dot suffix when it starts with `.` (`.internal`). Absent/empty ⇒ strict (no exemptions).
   *
   * Scoped to webhooks ALONE, deliberately: this is the one integration whose target URL is chosen
   * per workspace rather than by the operator, so folding it into another integration's allow-list
   * would let a workspace admin reach hosts that list was widened for.
   */
  allowUrlHosts?: string[]
  /** Permit `http` (not just `https`) — a plaintext receiver on a trusted internal network. */
  allowHttpUrls?: boolean
}

export interface ReleaseHealthConfig {
  /**
   * Opt-in flag (`OBSERVABILITY_ENABLED=true`). Requires an encryption key (the
   * per-workspace provider credentials are sealed at rest, no silent plaintext fallback).
   * When false the post-release-health gate is a pass-through and no release-health module
   * is assembled.
   */
  enabled: boolean
  /** Service-level master key (base64) backing observability-credential encryption at rest. */
  encryptionKey?: string
}

export interface SlackConfig {
  /**
   * Opt-in flag. Requires an encryption key (the per-account bot token is sealed
   * at rest, no silent plaintext fallback). When false the Slack module isn't
   * assembled and no Slack channel is composed into the notification fan-out.
   */
  enabled: boolean
  /** Service-level master key (base64) backing bot-token encryption at rest. */
  encryptionKey?: string
  // Slack app OAuth credentials moved out of env into per-account settings (sealed),
  // resolved dynamically at connect time. See AccountSettingsService / `/accounts/:id/settings`.
}

export interface RetentionConfig {
  tokenUsageMs: number
  rateLimitMs: number
  commitMs: number
  /**
   * LLM observability sink (full per-call prompt/response). Heavy, so the window trades disk
   * against how far back a post-mortem can reach; default 14 days, because most investigations
   * start after the run they are about has stopped being recent.
   */
  llmCallMetricsMs: number
  /**
   * Provisioning event log (one row per spin-up/down attempt). High-churn and only
   * useful for recent debugging, so pruned aggressively (default 14 days). 0 disables.
   */
  provisioningLogMs: number
  /**
   * Resolved (acted/dismissed) notifications. A busy workspace raises a card on every
   * waiting/decision/park event, so terminal rows would accumulate without bound. Only
   * resolved cards past the window are pruned — open ones (the actionable inbox) are
   * never touched. Generous by default (90 days), so the inbox's recent history stays
   * intact. 0 disables.
   */
  notificationsMs: number
  /**
   * The settled-gate projection (`gate_outcomes`) behind the operator dashboard's gate /
   * CI-fixer attempt statistics. One row per settled gate, so it grows far slower than the
   * call telemetry, but it is still unbounded: pruned on a generous window (default 90 days,
   * matching the longest dashboard window plus room to spare). 0 disables.
   */
  gateOutcomesMs: number
  /**
   * The daily run rollup (`platform_run_days`) behind the `30d` / `90d` dashboard windows.
   * Deliberately the LONGEST window of the lot (default 400 days): a rolled-up day is a
   * handful of tiny rows, and the whole point of the table is answering questions the raw
   * scan is too expensive for, which is exactly what a short retention would take away.
   * 0 disables.
   */
  runDaysMs: number
  /**
   * The account AUDIT LOG (`audit_events`). By far the LONGEST window here (default ~2 years),
   * and deliberately so: every other table on this list answers an operational question about
   * recent activity, while this one answers a compliance question about the past. An org adopting
   * the platform is asked "who changed that, and when" about things that happened long after
   * anyone stopped watching, and a short window would make the honest answer "we deleted it".
   *
   * It is nonetheless BOUNDED rather than infinite, because the log is the one table that grows
   * monotonically with run volume and D1's ceiling is 10 GB per database (the arithmetic is in
   * `backend/docs/storage-and-retention.md`). A deployment with a longer legal obligation raises
   * the knob; 0 disables the prune entirely, which is the right setting for a deployment that
   * exports the log elsewhere and wants nothing dropped locally.
   *
   * It has its OWN knob rather than sharing one, which is the governance half of keeping the log
   * in its own store: audit retention cannot be shortened as a side effect of tuning something
   * else, because no other table lives behind this name.
   */
  auditEventsMs: number
}

export interface FragmentLibraryConfig {
  /** Opt-in flag (`PROMPT_LIBRARY_ENABLED=true`); needs no encryption key. */
  enabled: boolean
  /** Relevance selection mode: 'llm' ranks per run; 'deterministic' matches tags. */
  selector: 'llm' | 'deterministic'
}

export interface ObservabilityConfig {
  /**
   * Whether the LLM observability sink persists the full prompt body with each
   * metric. Default true. When false (`LLM_RECORD_PROMPTS=false`) the numeric
   * telemetry (tokens, timing, finish reason, message/tool counts) is still recorded,
   * but the prompt text is stored empty — for deployments that must not retain the
   * (potentially sensitive) complete prompts sent to the model.
   */
  recordPrompts: boolean
}

export interface LangfuseConfig {
  /**
   * Opt-in flag (`LANGFUSE_ENABLED=true`). Requires both keys; when false (or a key is
   * missing) no Langfuse sink is built and there is no external emission. Off by default,
   * exactly like every other opt-in integration (Slack, environments, runners).
   */
  enabled: boolean
  /** Langfuse public key (`pk-lf-…`). */
  publicKey?: string
  /** Langfuse secret key (`sk-lf-…`). */
  secretKey?: string
  /** Host of the Langfuse instance; defaults to Langfuse Cloud when omitted. */
  baseUrl?: string
}

export interface OtelConfig {
  /**
   * Opt-in flag (`OTEL_ENABLED=true`). Requires {@link endpoint}; when false (or the
   * endpoint is missing) no OpenTelemetry exporter is built and there is no external
   * emission. Off by default, like every other opt-in integration. Composes ALONGSIDE
   * Langfuse (both feed the single trace sink via a fan-out) when both are enabled.
   */
  enabled: boolean
  /** OTLP/HTTP base URL (`OTEL_EXPORTER_OTLP_ENDPOINT`), e.g. `http://collector:4318`. */
  endpoint?: string
  /** Parsed `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated `k=v`), e.g. auth tokens. */
  headers?: Record<string, string>
  /** OTLP resource `service.name` (`OTEL_SERVICE_NAME`); defaults to `cat-factory`. */
  serviceName?: string
  /**
   * Deployment-level (platform-operator) metrics export: a periodic sweep pushes the
   * aggregate run-health projection (outcomes, failure taxonomy, live/parked depth, duration
   * percentiles) per account to the same OTLP endpoint as OpenTelemetry GAUGE metrics. A
   * further opt-in ON TOP of the base OTel exporter, since it adds recurring DB rollup load;
   * off unless {@link enabled} AND `OTEL_PLATFORM_METRICS=true`.
   */
  platformMetrics: OtelPlatformMetricsConfig
  /**
   * Structured LOG export: every line the platform emits (at the configured `LOG_LEVEL`) is
   * copied to the same OTLP endpoint as OTLP log records, so an operator reads logs, traces
   * and metrics in one backend. A further opt-in ON TOP of the base OTel exporter, since it
   * adds an egress POST per batch of lines; off unless {@link enabled} AND `OTEL_LOGS=true`.
   */
  logs: OtelLogsConfig
}

export interface OtelLogsConfig {
  /** Opt-in flag (`OTEL_LOGS=true`); only effective when the base OTel exporter is on. */
  enabled: boolean
  /**
   * How often the buffered lines are flushed (ms). Node reads `OTEL_LOGS_FLUSH_INTERVAL_MS`
   * (default 5s); the Worker flushes at the END OF EVERY INVOCATION instead (its module state
   * is per isolate and an isolate is discarded without notice) and ignores this.
   */
  flushIntervalMs: number
  /**
   * Lines per OTLP POST (`OTEL_LOGS_MAX_BATCH_SIZE`, default 128). Also bounds what a
   * collector outage may hold in memory: the exporter buffers a small multiple of it and
   * drops the oldest beyond that, reporting the drop count on the next batch.
   */
  maxBatchSize: number
}

export interface OtelPlatformMetricsConfig {
  /** Opt-in flag (`OTEL_PLATFORM_METRICS=true`); only effective when the base OTel exporter is on. */
  enabled: boolean
  /**
   * How often the sweep runs (ms). Node reads `OTEL_PLATFORM_METRICS_INTERVAL_MS` (default
   * 60s); the Worker is cron-driven (its 2-minute `scheduled` tick) and ignores this.
   */
  intervalMs: number
  /**
   * The trailing window each pushed snapshot aggregates over (`1h`/`24h`/`7d`; default `1h`).
   * The OTel backend builds longer trends from the gauge time series, so the shortest window
   * is the most operationally useful default.
   */
  window: PlatformObservabilityWindow
}

/**
 * Platform-health ALERTING config — the push counterpart to the operator dashboard read. A
 * periodic sweep (Worker cron ⇄ Node interval, runtime-symmetric) evaluates each account's
 * aggregate run-health projection against {@link thresholds} and raises a `platform_health`
 * notification when a ceiling is crossed (auto-clearing when it recovers). Independent of the
 * OTel exporter: alerts fan out through the existing NotificationChannel seam (in-app + Slack),
 * so this is on whenever `PLATFORM_ALERTS=true`, not gated on OTel. Off by default (it adds
 * recurring DB rollup load); a no-op at sweep time unless the notifications module AND the
 * platform-observability read are both wired.
 */
export interface PlatformAlertConfig {
  /** Opt-in flag (`PLATFORM_ALERTS=true`). */
  enabled: boolean
  /**
   * The trailing window each evaluation aggregates over (default `1h`). Deliberately the
   * live-scanned subset of the dashboard's windows: an alert is a statement about NOW, and the
   * `30d`/`90d` windows read a table materialised at best hourly.
   */
  window: PlatformAlertWindow
  /**
   * How often the sweep runs (ms). Node reads `PLATFORM_ALERTS_INTERVAL_MS` (default 5min);
   * the Worker is cron-driven (its 2-minute `scheduled` tick) and ignores this.
   */
  intervalMs: number
  /** The alert ceilings (env-driven; a settings surface is a later slice). */
  thresholds: PlatformAlertThresholds
}

/**
 * The infrastructure-REACHABILITY watcher: periodically probes each workspace's CONFIGURED
 * infrastructure connections and reports a dead one as `unreachable` on the setup projection.
 *
 * Opt-in, because it is the one sweep that makes an OUTBOUND call per workspace per pass — to a
 * cluster apiserver or a runner pool the deployment does not own. On a hosted deployment with many
 * boards that is a real, recurring cost profile the operator has to choose; the motivating case (a
 * local/self-hosted stack whose environment provider dies with the laptop) is one workspace.
 */
export interface InfraReachabilityConfig {
  /** Opt-in flag (`INFRA_REACHABILITY_WATCH=true`). */
  enabled: boolean
  /**
   * How often the sweep runs (ms), from `INFRA_REACHABILITY_INTERVAL_MS` (default 5min). Node times
   * it directly; the Worker, whose `scheduled` tick fires every 2 minutes for every backstop, gates
   * this sweep on `shouldRunReachabilityPass` so the same setting means the same cadence there. It
   * is the operator's only lever on the one sweep that calls OUT per workspace, so a facade that
   * ignored it would make opting in an all-or-nothing choice.
   */
  intervalMs: number
  /**
   * Per-probe timeout (ms), so one hung apiserver can't stall the pass for every other workspace.
   * A timeout counts as UNREACHABLE, not as an indeterminate result: a connection that doesn't
   * answer inside the budget is exactly the outage this watcher exists to report.
   */
  probeTimeoutMs: number
}

/**
 * GitLab VCS provider config (the neutral-VCS abstraction's second backend), shaped exactly like
 * {@link GitHubConfig}: ALWAYS present, with `enabled` the separate opt-in gate.
 *
 * The split matters because the two facts have different lifetimes. `apiBase` is the ADDRESS of
 * the instance this deployment talks to, which a deployment has whether or not it wired the
 * single-token engine connection: local mode reaches GitLab with a `GITLAB_PAT` and no
 * `GITLAB_TOKEN`, so `enabled` is false there while the workspace very much has a GitLab
 * connection whose repos, merge requests and issues need linking. Gating the whole object on the
 * token (as this once did) made the address unreadable on exactly that deployment, and every
 * derived web link was silently withheld.
 *
 * `enabled` covers only the single-token model (mirrors local-mode's PAT): one connection per
 * deployment, registered via `registerGitLab` and resolved through the process-wide VCS registry.
 * The raw token is NOT carried here (the facade reads it straight from env at wiring time); this
 * holds only the non-secret address + the webhook secret the neutral ingest route verifies
 * against. Every field beside `apiBase` is inert while `enabled` is false, exactly as
 * {@link GitHubConfig}'s `appId` is when no App is configured.
 */
export interface GitLabConfig {
  enabled: boolean
  /**
   * REST v4 API base, e.g. `https://gitlab.com/api/v4` (per-instance for self-managed).
   * Populated on every deployment, defaulting to the public instance, because it is also the
   * source the browser-facing web host is derived from (`resolveVcsWebUrls`).
   */
  apiBase: string
  /** The single connection's id — the `VcsConnectionRef.connectionId` callers resolve on. */
  connectionId: string
  /** Shared secret compared against the inbound `X-Gitlab-Token` webhook header; '' when unset. */
  webhookSecret: string
  /**
   * The deployment `ENCRYPTION_KEY` (base64), used to seal a per-workspace GitLab PAT at rest for
   * the connect flow. Present whenever the facade has an encryption key configured; absent ⇒ the
   * per-workspace PAT connect surface is not wired (the deployment still gates/merges on the
   * single-token engine client). Domain-separated under `cat-factory:vcs-token`.
   */
  encryptionKey?: string
}

export interface AppConfig {
  agents: AgentsConfig
  /** The effective model picker catalog (each model's active flavour). */
  models: ModelOption[]
  execution: ExecutionConfig
  /** Pricing + budget for the spend safeguard. */
  spend: SpendPricing
  /** GitHub integration config; `enabled` is false unless a GitHub App is set up. */
  github: GitHubConfig
  /** GitLab VCS provider config; `enabled` is false unless `GITLAB_TOKEN` is set. */
  gitlab: GitLabConfig
  /** "Login with GitHub" config; `enabled` is false unless an OAuth app is set up. */
  auth: AuthConfig
  /** Document-source integration config; always on where the runtime serves documents. */
  documents: DocumentsConfig
  /** Task-source integration config; always on where the runtime serves task sources. */
  tasks: TasksConfig
  /** Environment provider integration config; assembles wherever an encryption key is set. */
  environments: EnvironmentsConfig
  /** Self-hosted runner-pool config; `enabled` is false unless opted in. */
  runners: RunnerPoolConfig
  /** Slack notification-transport config; `enabled` is false unless opted in. */
  slack: SlackConfig
  /** Outbound notification-webhook transport; only its URL guard is configurable. */
  notificationWebhooks: NotificationWebhookConfig
  /** Observability post-release-health config; `enabled` is false unless opted in. */
  releaseHealth: ReleaseHealthConfig
  /** Transactional email config (invitations); `enabled` is false unless opted in. */
  email: EmailConfig
  /** Retention windows for the unbounded ledgers/projections (epoch-ms ages). */
  retention: RetentionConfig
  /** Prompt-fragment library config; `enabled` is false unless opted in (ADR 0006). */
  fragmentLibrary: FragmentLibraryConfig
  /** LLM observability config (e.g. whether complete prompts are recorded). */
  observability: ObservabilityConfig
  /**
   * How this deployment constrains OpenRouter's provider routing
   * (`OPENROUTER_DATA_COLLECTION`, `OPENROUTER_REQUIRE_PARAMETERS`). Absent ⇒
   * `DEFAULT_OPENROUTER_ROUTING`, strict on both axes, which is this platform's default rather
   * than the vendor's: an agent prompt carries the customer's checkout, and an upstream that
   * ignores a tool definition answers the wrong shape without saying so. The INLINE path reads
   * the same two env vars through its own facade wiring; this is the CONTAINER-proxy half.
   */
  openRouterRouting?: OpenRouterRouting
  /** Optional Langfuse trace-sink config; `enabled` is false unless opted in. */
  langfuse: LangfuseConfig
  /** Optional OpenTelemetry (OTLP) trace + metrics config; `enabled` is false unless opted in. */
  otel: OtelConfig
  /** Platform-health alerting config; `enabled` is false unless `PLATFORM_ALERTS=true`. */
  platformAlerts: PlatformAlertConfig
  /**
   * Infrastructure-reachability watcher config; `enabled` is false unless
   * `INFRA_REACHABILITY_WATCH=true`.
   */
  infraReachability: InfraReachabilityConfig
  /**
   * Local-mode facade signals surfaced to the SPA; present only on the local facade
   * (the Worker/Node facades leave it undefined). Carries the missing-PAT setup prompt.
   */
  localMode?: LocalModeConfig
  /**
   * The deployment's infrastructure execution backends, surfaced via `/auth/config` so the
   * SPA presents a clear selector of what's available + active. Set by every facade (see
   * `buildInfrastructureCapabilities`); optional so tests/builders that omit it still type.
   */
  infrastructure?: InfrastructureCapabilities
  /**
   * NATIVE LOCAL EXECUTION (local facade only, opt-in via `LOCAL_NATIVE_AGENTS`): the
   * ALLOW-LIST of subscription harnesses that run on the host with the developer's OWN
   * installed CLI + ambient login (parsed from the comma-separated env, e.g.
   * `claude-code,codex`). Non-empty ⇒ native mode is on: the personal-credential gate is
   * skipped (no leased/pooled credential is used) and the executor flags `ambientAuth` for
   * a listed harness whose vendor is the native CLI's own vendor. Absent/empty everywhere
   * else. Only `claude-code` / `codex` are meaningful here (a non-native vendor reusing the
   * `claude-code` harness is still leased normally — see `ContainerAgentExecutor`).
   */
  nativeAmbientAuth?: HarnessKind[]
}
