import { vcsWebBaseUrl, type VcsWebUrls } from '@cat-factory/kernel'
import type { AppConfig } from './types.js'

/**
 * The browser-facing base URL of each provider's configured instance, derived from the REST base
 * the deployment already configures (`GITHUB_API_BASE` / `GITLAB_API_BASE`).
 *
 * ONE derivation for the whole platform: both facades call this to fill `CoreDependencies`, so
 * the connection responses and the connect-capability route answer with the same host, and
 * neither runtime can drift into naming a different one. A provider whose base does not invert
 * (see `vcsWebBaseUrl`) is simply absent, which the SPA renders by withholding the links that
 * needed a host rather than pointing at the provider's public instance.
 *
 * Keyed off the API BASE alone, never off a provider's `enabled` flag: local mode connects
 * GitHub with a PAT and no App, so `config.github.enabled` is false there while the workspace
 * very much has a GitHub connection whose repos need linking. Nothing reads a host for a
 * provider it has no connection or connect option for, so an unused entry costs nothing.
 */
export function resolveVcsWebUrls(config: AppConfig): VcsWebUrls {
  const urls: { -readonly [K in keyof VcsWebUrls]: VcsWebUrls[K] } = {}
  const github = vcsWebBaseUrl('github', config.github.apiBase)
  if (github) urls.github = github
  const gitlabApiBase = config.gitlab?.apiBase
  const gitlab = gitlabApiBase ? vcsWebBaseUrl('gitlab', gitlabApiBase) : null
  if (gitlab) urls.gitlab = gitlab
  return urls
}
