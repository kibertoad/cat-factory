// Per-account (deployment-wide) integration settings. Mirrors
// `@cat-factory/contracts` accountSettings. Secrets are write-only — the read view
// returns only `config` + a non-secret presence `summary`.

export interface SlackOAuthSecret {
  clientId: string
  clientSecret: string
  redirectUrl: string
}

export interface WebSearchSecret {
  braveApiKey?: string
  searxngUrl?: string
  searxngApiKey?: string
}

/** Non-secret per-account config (empty today; reserved for forward-compatible tuning). */
export type AccountSettingsConfig = Record<string, never>

export interface AccountSettingsSummary {
  slackOAuthConfigured: boolean
  webSearch: 'brave' | 'searxng' | null
}

export interface AccountSettingsView {
  config: AccountSettingsConfig
  summary: AccountSettingsSummary
}

/**
 * Admin write. Each secrets group: omit ⇒ leave unchanged, `null` ⇒ clear, value ⇒ set.
 */
export interface UpdateAccountSettingsInput {
  config?: AccountSettingsConfig
  secrets?: {
    slackOAuth?: SlackOAuthSecret | null
    webSearch?: WebSearchSecret | null
  }
}
