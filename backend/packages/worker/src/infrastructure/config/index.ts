import type { ModelOption } from '@cat-factory/contracts'
import { effectiveCatalog, type SpendPricing } from '@cat-factory/core'
import type { Env } from '../env'
import { directKeyAvailable } from './utils'
import { type AgentsConfig, loadAgentsConfig } from './agents'
import { type ExecutionConfig, loadExecutionConfig } from './execution'
import { loadSpendPricing } from './spending'
import { type GitHubConfig, loadGitHubConfig } from './github'
import { type AuthConfig, loadAuthConfig } from './auth'
import { type DocumentsConfig, loadDocumentsConfig } from './documents'
import { type EnvironmentsConfig, loadEnvironmentsConfig } from './environments'
import { type RetentionConfig, loadRetentionConfig } from './retention'

// Translates the flat, string-typed Worker environment into a structured app
// config — in particular the agent model routing ("which LLM, with what config,
// for what"). Operators tune behaviour entirely through wrangler vars / secrets.
// Each concern lives in a sibling module; this barrel composes them.

export type {
  AgentsConfig,
  ExecutionConfig,
  GitHubConfig,
  AuthConfig,
  DocumentsConfig,
  EnvironmentsConfig,
  RetentionConfig,
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
  /** Environment provider integration config; `enabled` is false unless opted in. */
  environments: EnvironmentsConfig
  /** Retention windows for the unbounded ledgers/projections (epoch-ms ages). */
  retention: RetentionConfig
}

export function loadConfig(env: Env): AppConfig {
  const isDirectAvailable = directKeyAvailable(env)
  return {
    agents: loadAgentsConfig(env, isDirectAvailable),
    models: effectiveCatalog(isDirectAvailable),
    execution: loadExecutionConfig(env),
    spend: loadSpendPricing(env),
    github: loadGitHubConfig(env),
    auth: loadAuthConfig(env),
    documents: loadDocumentsConfig(env),
    environments: loadEnvironmentsConfig(env),
    retention: loadRetentionConfig(env),
  }
}
