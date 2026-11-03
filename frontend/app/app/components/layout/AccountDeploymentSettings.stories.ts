import type { Meta, StoryObj } from '@storybook/vue3'
import type { AccountSettingsView } from '@cat-factory/contracts'
import { getAccountSettingsContract } from '@cat-factory/contracts'
import { apiFailure, apiResponse } from '~/stories/api'
import { accountSettingsView, orgAccount } from '~/stories/accounts.stories.mocks'
import AccountDeploymentSettings from './AccountDeploymentSettings.vue'

// The account's integration secrets, for account admins: the Slack, Linear and Figma app
// credentials, the web search keys, and where binary artifacts (screenshots) are stored. A
// secret is write-only, so each section says only whether it is set. The storage section lists
// the backends this runtime supports and any store the deployment registers in code. The panel
// loads the settings when it mounts, so each story answers that read. The bucket, paths and
// store names are made up.
const noStorageSummary = {
  backend: null,
  bucket: null,
  basePath: null,
  s3CredentialsConfigured: false,
  customStoreId: null,
} satisfies AccountSettingsView['summary']['contentStorage']

function settingsAre(view: AccountSettingsView) {
  return apiResponse(getAccountSettingsContract, {
    pathParams: { accountId: orgAccount.id },
    body: view,
  })
}

/** A Node runtime: off, filesystem, S3 and the database, with the database as its default. */
function nodeView(
  config: AccountSettingsView['config'],
  contentStorage: AccountSettingsView['summary']['contentStorage'],
  extra: Partial<AccountSettingsView['contentStorageCapability']> = {},
): AccountSettingsView {
  return {
    config,
    summary: { ...accountSettingsView.summary, contentStorage },
    contentStorageCapability: {
      supportedBackends: ['off', 'fs', 's3', 'db'],
      defaultBackend: 'db',
      customStores: [],
      ...extra,
    },
  }
}

const meta = {
  title: 'Settings/Components/AccountDeploymentSettings',
  component: AccountDeploymentSettings,
  args: { accountId: orgAccount.id },
  parameters: {
    width: 'prose',
    api: [
      settingsAre({
        ...accountSettingsView,
        config: { contentStorage: { backend: 'db' } },
        summary: { ...accountSettingsView.summary, webSearch: 'brave' },
      }),
    ],
  },
} satisfies Meta<typeof AccountDeploymentSettings>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Slack and Brave search set, each with Clear; Linear and Figma not set; artifacts stored in the
 * database.
 */
export const Default: Story = {}

/** Nothing set: every section says Not set, and storage is on the runtime's default. */
export const Unconfigured: Story = {
  parameters: {
    api: [
      settingsAre({
        ...nodeView({}, noStorageSummary),
        summary: {
          slackOAuthConfigured: false,
          linearOAuthConfigured: false,
          figmaOAuthConfigured: false,
          webSearch: null,
          contentStorage: noStorageSummary,
        },
      }),
    ],
  },
}

/** S3 storage: the bucket fields, path style, and the stored access keys. */
export const S3Storage: Story = {
  parameters: {
    api: [
      settingsAre(
        nodeView(
          {
            contentStorage: {
              backend: 's3',
              s3: {
                region: 'eu-central-1',
                bucket: 'acme-cat-factory-artifacts',
                prefix: 'screenshots/',
                endpoint: 'https://s3.eu-central-1.amazonaws.com',
              },
            },
          },
          {
            ...noStorageSummary,
            backend: 's3',
            bucket: 'acme-cat-factory-artifacts',
            s3CredentialsConfigured: true,
          },
        ),
      ),
    ],
  },
}

/** Filesystem storage: the base path field. */
export const FsStorage: Story = {
  parameters: {
    api: [
      settingsAre(
        nodeView(
          { contentStorage: { backend: 'fs', fs: { basePath: '/var/lib/cat-factory/artifacts' } } },
          { ...noStorageSummary, backend: 'fs', basePath: '/var/lib/cat-factory/artifacts' },
        ),
      ),
    ],
  },
}

/**
 * The account names a store this deployment does not register: the select keeps it as an
 * option, marked, and a warning says nothing is stored. The deployment registers one other store.
 */
export const UnregisteredStore: Story = {
  parameters: {
    api: [
      settingsAre(
        nodeView(
          { contentStorage: { backend: 'custom', custom: { storeId: 'gcs-archive' } } },
          { ...noStorageSummary, backend: 'custom', customStoreId: 'gcs-archive' },
          {
            supportedBackends: ['off', 'db', 'custom'],
            customStores: [
              {
                id: 'azure-blob',
                name: 'Azure Blob (Acme)',
                summary: 'Stores artifacts in the acme-artifacts container.',
              },
            ],
          },
        ),
      ),
    ],
  },
}

/**
 * The load failed: a toast, and every section says Not set with no storage section, which reads
 * like an account with nothing configured.
 */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(getAccountSettingsContract, { pathParams: { accountId: orgAccount.id } })],
  },
}
