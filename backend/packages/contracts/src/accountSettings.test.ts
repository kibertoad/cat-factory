import { describe, expect, it } from 'vitest'
import type { AccountSettingsConfig, AccountSettingsSecrets } from './accountSettings.js'
import * as v from 'valibot'
import { accountSettingsSummary, contentStorageConfigSchema } from './accountSettings.js'

// accountSettingsSummary derives the NON-SECRET presence view returned by GET (secrets are
// write-only). A regression here misreports whether a credential is configured — so pin the
// presence booleans, the brave>searxng precedence, and that no secret value leaks into the view.
describe('accountSettingsSummary', () => {
  it('reports everything unconfigured for empty secrets', () => {
    expect(accountSettingsSummary({})).toEqual({
      slackOAuthConfigured: false,
      linearOAuthConfigured: false,
      figmaOAuthConfigured: false,
      webSearch: null,
      contentStorage: {
        backend: null,
        bucket: null,
        basePath: null,
        s3CredentialsConfigured: false,
        customStoreId: null,
      },
    })
  })

  it('flags oauth presence as booleans without echoing values', () => {
    const secrets: AccountSettingsSecrets = {
      slackOAuth: { clientId: 'id', clientSecret: 'shh', redirectUrl: 'https://x/y' },
      linearOAuth: { clientId: 'id', clientSecret: 'shh', redirectUrl: 'https://x/y' },
      figmaOAuth: { clientId: 'id', clientSecret: 'shh', redirectUrl: 'https://x/y' },
    }
    const summary = accountSettingsSummary(secrets)
    expect(summary.slackOAuthConfigured).toBe(true)
    expect(summary.linearOAuthConfigured).toBe(true)
    expect(summary.figmaOAuthConfigured).toBe(true)
    // No secret value should appear anywhere in the derived summary.
    expect(JSON.stringify(summary)).not.toContain('shh')
  })

  it('prefers brave over searxng when both are present', () => {
    const both: AccountSettingsSecrets = {
      webSearch: { braveApiKey: 'bk', searxngUrl: 'https://searx' },
    }
    expect(accountSettingsSummary(both).webSearch).toBe('brave')
  })

  it('falls back to searxng when only searxng is configured', () => {
    const searx: AccountSettingsSecrets = { webSearch: { searxngUrl: 'https://searx' } }
    expect(accountSettingsSummary(searx).webSearch).toBe('searxng')
  })

  it('is null when a webSearch group exists but neither upstream is set', () => {
    expect(accountSettingsSummary({ webSearch: {} }).webSearch).toBeNull()
  })

  it('projects non-secret content-storage config and s3 credential presence', () => {
    const secrets: AccountSettingsSecrets = { s3: { accessKeyId: 'ak', secretAccessKey: 'sk' } }
    const config: AccountSettingsConfig = {
      contentStorage: { backend: 's3', s3: { region: 'us', bucket: 'my-bucket' } },
    }
    const summary = accountSettingsSummary(secrets, config)
    expect(summary.contentStorage).toEqual({
      backend: 's3',
      bucket: 'my-bucket',
      basePath: null,
      s3CredentialsConfigured: true,
      customStoreId: null,
    })
    expect(JSON.stringify(summary)).not.toContain('sk')
  })

  it('names the deployment-registered store a custom selection points at', () => {
    // `custom` alone identifies nothing: two registered stores read identically in the summary
    // until the id is carried beside the backend, which is what the settings panel labels the
    // account with and what tells an operator their build no longer registers it.
    const config: AccountSettingsConfig = {
      contentStorage: { backend: 'custom', custom: { storeId: 'gcs' } },
    }
    const cs = accountSettingsSummary({}, config).contentStorage
    expect(cs.backend).toBe('custom')
    expect(cs.customStoreId).toBe('gcs')
  })

  it('surfaces the fs base path when the fs backend is selected', () => {
    const config: AccountSettingsConfig = {
      contentStorage: { backend: 'fs', fs: { basePath: '.store' } },
    }
    const cs = accountSettingsSummary({}, config).contentStorage
    expect(cs.backend).toBe('fs')
    expect(cs.basePath).toBe('.store')
    expect(cs.bucket).toBeNull()
  })
})

describe('contentStorageConfigSchema', () => {
  it('refuses a custom selection that names no store', () => {
    // The one content-storage config that cannot mean anything: refused where it is WRITTEN, so
    // an account never reads as configured while storing nothing.
    expect(() => v.parse(contentStorageConfigSchema, { backend: 'custom' })).toThrow()
    expect(() =>
      v.parse(contentStorageConfigSchema, { backend: 'custom', custom: { storeId: '' } }),
    ).toThrow()
  })

  it('accepts a custom selection with its store id', () => {
    expect(
      v.parse(contentStorageConfigSchema, { backend: 'custom', custom: { storeId: 'gcs' } }),
    ).toEqual({ backend: 'custom', custom: { storeId: 'gcs' } })
  })

  it('leaves the built-in backends unconstrained by the custom rule', () => {
    expect(v.parse(contentStorageConfigSchema, { backend: 'fs' })).toEqual({ backend: 'fs' })
  })
})
