import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentOriginLink from './DocumentOriginLink.vue'

// A document's name as a link to its origin page, opening in a new tab with the URL as its
// tooltip. An uploaded document has an empty URL, so it renders as plain text with a tooltip
// saying it was uploaded. The caller's hover class applies only to a real link.
const meta = {
  title: 'Documents/Components/DocumentOriginLink',
  component: DocumentOriginLink,
  parameters: { width: 'panel' },
  render: (args) => ({
    components: { DocumentOriginLink },
    setup: () => ({ args }),
    template: '<DocumentOriginLink v-bind="args">Engineering handbook</DocumentOriginLink>',
  }),
} satisfies Meta<typeof DocumentOriginLink>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { url: 'https://example.invalid/handbook/auth' } }

/** Uploaded: no URL, so a plain span. It looks the same as `Default`; only the tooltip differs. */
export const Uploaded: Story = { args: { url: '' } }

/** With a caller's hover class, which also underlines the link at rest. */
export const WithHoverClass: Story = {
  args: {
    url: 'https://example.invalid/handbook/auth',
    hoverClass: 'hover:text-primary underline',
  },
}
