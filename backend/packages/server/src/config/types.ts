import type { AgentRouting } from '@cat-factory/agents'
import type { ModelOption } from '@cat-factory/contracts'
import type { DocumentSourceKind, ModelRef, TaskSourceKind } from '@cat-factory/kernel'
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
  /** Present only when a privileged App is configured AND its key is supplied. */
  privilegedApp?: PrivilegedAppConfig
}

export interface AuthConfig {
  enabled: boolean
  /** Local-dev/test ONLY: permit running with auth unconfigured (open API). */
  devOpen: boolean
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
}

export interface DocumentsConfig {
  /** Opt-in flag. Requires an encryption key (no silent plaintext fallback). */
  enabled: boolean
  /** Which source providers to register (default: all). */
  sources: DocumentSourceKind[]
  /** 'llm' uses the agent model to plan structure; 'headings' forces the parser. */
  planner: 'llm' | 'headings'
  /** Service-level master key (base64) backing source-credential encryption at rest. */
  encryptionKey?: string
}

export interface TasksConfig {
  /** Opt-in flag. Requires an encryption key (no silent plaintext fallback). */
  enabled: boolean
  /** Which source providers to register (default: all). */
  sources: TaskSourceKind[]
  /** Service-level master key (base64) backing source-credential encryption at rest. */
  encryptionKey?: string
}

export interface EnvironmentsConfig {
  /** Opt-in flag. Requires an encryption key (no silent plaintext fallback). */
  enabled: boolean
  /** Service-level master key (base64) backing credential encryption at rest. */
  encryptionKey?: string
}

export interface RunnerPoolConfig {
  /** Opt-in flag. Requires an encryption key (no silent plaintext fallback). */
  enabled: boolean
  /** Service-level master key (base64) backing credential encryption at rest. */
  encryptionKey?: string
}

export interface RetentionConfig {
  tokenUsageMs: number
  rateLimitMs: number
  commitMs: number
}

export interface FragmentLibraryConfig {
  /** Opt-in flag (`PROMPT_LIBRARY_ENABLED=true`); needs no encryption key. */
  enabled: boolean
  /** Relevance selection mode: 'llm' ranks per run; 'deterministic' matches tags. */
  selector: 'llm' | 'deterministic'
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
  /** Document-source integration config; `enabled` is false unless opted in. */
  documents: DocumentsConfig
  /** Task-source integration config; `enabled` is false unless opted in. */
  tasks: TasksConfig
  /** Environment provider integration config; `enabled` is false unless opted in. */
  environments: EnvironmentsConfig
  /** Self-hosted runner-pool config; `enabled` is false unless opted in. */
  runners: RunnerPoolConfig
  /** Retention windows for the unbounded ledgers/projections (epoch-ms ages). */
  retention: RetentionConfig
  /** Prompt-fragment library config; `enabled` is false unless opted in (ADR 0006). */
  fragmentLibrary: FragmentLibraryConfig
}
