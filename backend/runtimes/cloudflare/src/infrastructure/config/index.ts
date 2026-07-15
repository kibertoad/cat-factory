import { type AppConfig, requireEncryptionKey } from '@cat-factory/server'
import {
  ALL_SUBSCRIPTION_VENDORS,
  type ProviderCapabilities,
  effectiveCatalog,
} from '@cat-factory/kernel'
import { modelCostResolver } from '@cat-factory/spend'
import type { Env } from '../env'
import { type AgentsConfig, loadAgentsConfig } from './agents'
import { type ExecutionConfig, loadExecutionConfig } from './execution'
import { loadSpendPricing } from './spending'
import { type GitHubConfig, loadGitHubConfig } from './github'
import { loadGitLabConfig } from './gitlab'
import { type AuthConfig, loadAuthConfig } from './auth'
import { type DocumentsConfig, loadDocumentsConfig } from './documents'
import { type TasksConfig, loadTasksConfig } from './tasks'
import { type EnvironmentsConfig, loadEnvironmentsConfig } from './environments'
import { type RunnerPoolConfig, loadRunnerPoolConfig } from './runners'
import { type SlackConfig, loadSlackConfig } from './slack'
import { type ReleaseHealthConfig, loadReleaseHealthConfig } from './releaseHealth'
import { type EmailConfig, loadEmailConfig } from './email'
import { type RetentionConfig, loadRetentionConfig } from './retention'
import { type FragmentLibraryConfig, loadFragmentLibraryConfig } from './fragmentLibrary'
import { type ObservabilityConfig, loadObservabilityConfig } from './observability'
import { type LangfuseConfig, loadLangfuseConfig } from './langfuse'
import { type OtelConfig, loadOtelConfig } from './otel'

// Translates the flat, string-typed Worker environment into a structured app
// config — in particular the agent model routing ("which LLM, with what config,
// for what"). Operators tune behaviour entirely through wrangler vars / secrets.
// Each concern lives in a sibling module; this barrel composes them.

// The config SHAPE (AppConfig + every sub-config) is the shared contract in
// @cat-factory/server; this module re-exports it and owns the Worker's env-driven
// loaders that produce it.
export type {
  AgentsConfig,
  AppConfig,
  ExecutionConfig,
  GitHubConfig,
  AuthConfig,
  DocumentsConfig,
  TasksConfig,
  EnvironmentsConfig,
  RunnerPoolConfig,
  SlackConfig,
  ReleaseHealthConfig,
  EmailConfig,
  RetentionConfig,
  FragmentLibraryConfig,
  ObservabilityConfig,
  LangfuseConfig,
  OtelConfig,
}

export function loadConfig(env: Env): AppConfig {
  // Validate the system encryption key up front: present, valid base64, and decoding to a full
  // AES-256 key. It is effectively mandatory (the always-on document/task integrations seal
  // credentials at rest under it), so a missing/malformed binding fails here with an actionable
  // message rather than lazily inside the first cipher build. Mirrors the Node loader + local mode.
  requireEncryptionKey(env.ENCRYPTION_KEY)

  // Deployment-level capabilities: direct keys are now per-workspace (resolved at run
  // time from the DB pool), so none are known here; Cloudflare Workers AI is opt-in
  // (the `AI` binding). The per-workspace `/models` endpoint recomputes selectability
  // against each workspace's configured keys + subscriptions.
  const caps: ProviderCapabilities = {
    directProviders: new Set(),
    subscriptionVendors: new Set(ALL_SUBSCRIPTION_VENDORS),
    cloudflareEnabled: !!env.AI,
  }
  const spend = loadSpendPricing(env)
  return {
    agents: loadAgentsConfig(env, caps),
    // Surface each model's informational list cost in the picker (from spend pricing).
    models: effectiveCatalog(caps, modelCostResolver(spend)),
    execution: loadExecutionConfig(env),
    spend,
    github: loadGitHubConfig(env),
    gitlab: loadGitLabConfig(env),
    auth: loadAuthConfig(env),
    documents: loadDocumentsConfig(env),
    tasks: loadTasksConfig(env),
    environments: loadEnvironmentsConfig(env),
    runners: loadRunnerPoolConfig(env),
    slack: loadSlackConfig(env),
    releaseHealth: loadReleaseHealthConfig(env),
    email: loadEmailConfig(env),
    retention: loadRetentionConfig(env),
    fragmentLibrary: loadFragmentLibraryConfig(env),
    observability: loadObservabilityConfig(env),
    langfuse: loadLangfuseConfig(env),
    otel: loadOtelConfig(env),
  }
}
