import type { AppConfig } from '@cat-factory/server'
import { effectiveCatalog } from '@cat-factory/kernel'
import type { Env } from '../env'
import { directKeyAvailable } from './utils'
import { type AgentsConfig, loadAgentsConfig } from './agents'
import { type ExecutionConfig, loadExecutionConfig } from './execution'
import { loadSpendPricing } from './spending'
import { type GitHubConfig, loadGitHubConfig } from './github'
import { type AuthConfig, loadAuthConfig } from './auth'
import { type DocumentsConfig, loadDocumentsConfig } from './documents'
import { type TasksConfig, loadTasksConfig } from './tasks'
import { type EnvironmentsConfig, loadEnvironmentsConfig } from './environments'
import { type RunnerPoolConfig, loadRunnerPoolConfig } from './runners'
import { type RetentionConfig, loadRetentionConfig } from './retention'
import { type FragmentLibraryConfig, loadFragmentLibraryConfig } from './fragmentLibrary'

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
  RetentionConfig,
  FragmentLibraryConfig,
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
    tasks: loadTasksConfig(env),
    environments: loadEnvironmentsConfig(env),
    runners: loadRunnerPoolConfig(env),
    retention: loadRetentionConfig(env),
    fragmentLibrary: loadFragmentLibraryConfig(env),
  }
}
