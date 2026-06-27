import type { AgentRouting } from '@cat-factory/agents'
import type { LocalModeConfig, ModelOption } from '@cat-factory/contracts'
import type { DocumentSourceKind, HarnessKind, ModelRef } from '@cat-factory/kernel'
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
   */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
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
  /** Userinfo API base; defaults to Google's. */
  apiBase?: string
}

export interface AuthConfig {
  /** True when ANY login provider (GitHub OAuth / password / Google) is configured. */
  enabled: boolean
  /** Local-dev/test ONLY: permit running with auth unconfigured (open API). */
  devOpen: boolean
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
  /** Google OAuth config, present only when configured. */
  google?: GoogleOAuthConfig
  /**
   * Lowercased email domains permitted to self-signup (password/Google) without an
   * invite. Empty ⇒ new-user creation is invite-only (the default, fail-closed).
   */
  allowedEmailDomains: string[]
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
}

export interface EnvironmentsConfig {
  /** Opt-in flag. Requires an encryption key (no silent plaintext fallback). */
  enabled: boolean
  /** Service-level master key (base64) backing credential encryption at rest. */
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
   * LLM observability sink (full per-call prompt/response). Heavy, and only useful
   * for recent debugging, so it is pruned aggressively (default 3 days).
   */
  llmCallMetricsMs: number
  /**
   * Provisioning event log (one row per spin-up/down attempt). High-churn and only
   * useful for recent debugging, so pruned aggressively (default 14 days). 0 disables.
   */
  provisioningLogMs: number
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

export interface AppConfig {
  agents: AgentsConfig
  /** The effective model picker catalog (each model's active flavour). */
  models: ModelOption[]
  execution: ExecutionConfig
  /** Pricing + budget for the spend safeguard. */
  spend: SpendPricing
  /** GitHub integration config; `enabled` is false unless a GitHub App is set up. */
  github: GitHubConfig
  /** "Login with GitHub" config; `enabled` is false unless an OAuth app is set up. */
  auth: AuthConfig
  /** Document-source integration config; always on where the runtime serves documents. */
  documents: DocumentsConfig
  /** Task-source integration config; always on where the runtime serves task sources. */
  tasks: TasksConfig
  /** Environment provider integration config; `enabled` is false unless opted in. */
  environments: EnvironmentsConfig
  /** Self-hosted runner-pool config; `enabled` is false unless opted in. */
  runners: RunnerPoolConfig
  /** Slack notification-transport config; `enabled` is false unless opted in. */
  slack: SlackConfig
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
  /** Optional Langfuse trace-sink config; `enabled` is false unless opted in. */
  langfuse: LangfuseConfig
  /**
   * Local-mode facade signals surfaced to the SPA; present only on the local facade
   * (the Worker/Node facades leave it undefined). Carries the missing-PAT setup prompt.
   */
  localMode?: LocalModeConfig
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
