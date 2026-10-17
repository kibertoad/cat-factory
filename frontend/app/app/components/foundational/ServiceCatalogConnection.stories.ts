import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { serviceCatalogConnection } from '~/stories/foundational.stories.mocks'
import { seedFoundationalCatalog, withSeed } from '~/stories/withStores'
import ServiceCatalogConnection from './ServiceCatalogConnection.vue'

// A board's developer portal (Backstage), whose services are imported into the foundational
// catalog: the connection with what its last import concluded, Import now and Disconnect, and the
// form that connects a portal or replaces the connection. The form's fields follow the chosen
// way of signing in. The stories seed the connection the board's manager would load. The partial
// note is the backend's own (`describeImport` in agents); the failure is made up.
const connected = (overrides: Parameters<typeof serviceCatalogConnection>[0] = {}) =>
  withSeed(() => seedFoundationalCatalog({ serviceCatalog: serviceCatalogConnection(overrides) }))

const meta = {
  title: 'Settings/Components/ServiceCatalogConnection',
  component: ServiceCatalogConnection,
  decorators: [connected()],
  parameters: { width: 'prose' },
} satisfies Meta<typeof ServiceCatalogConnection>
export default meta

type Story = StoryObj<typeof meta>

/** Connected and imported in full, with the form that replaces the connection under it. */
export const Default: Story = {}

/** No portal connected: the connect form only. */
export const Empty: Story = {
  decorators: [withSeed(() => seedFoundationalCatalog({ serviceCatalog: null }))],
}

/** The import stopped at the service cap: a warning badge and the note that says so. */
export const Partial: Story = {
  decorators: [
    connected({
      lastSyncStatus: 'partial',
      lastSyncMessage:
        "The import stopped at the configured service cap after 200 services, so this catalog is a PREFIX of the portal's estate. Narrow the entity filter, or raise the cap.",
    }),
  ],
}

/** The portal could not be reached: an error badge and the transport failure. */
export const Failed: Story = {
  decorators: [
    connected({
      lastSyncStatus: 'failed',
      lastSyncMessage: 'Backstage portal unreachable: connect ECONNREFUSED 10.0.4.12:443',
    }),
  ],
}

/** The deployment has no key to seal a portal credential: a note in place of the panel. */
export const Unavailable: Story = {
  decorators: [withSeed(() => seedFoundationalCatalog({ serviceCatalogAvailable: false }))],
}

/** OAuth2 client credentials picked: the token URL, client and scope fields. */
export const OAuthMode: Story = {
  decorators: [withSeed(() => seedFoundationalCatalog({ serviceCatalog: null }))],
  play: async () => {
    await userEvent.click(await screen.findByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: 'OAuth2 client credentials' }))
    await screen.findByPlaceholderText('https://idp.example.com/oauth2/token')
  },
}
