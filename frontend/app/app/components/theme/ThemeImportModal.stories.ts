import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import ThemeImportModal from './ThemeImportModal.vue'

// The dialog that imports a theme from the Nuxt UI theme editor's share link. The modal is
// teleported to the page body, so the plays query `screen`. Every open clears both fields.
const meta = {
  title: 'Shell/Components/ThemeImportModal',
  component: ThemeImportModal,
  args: { open: true },
} satisfies Meta<typeof ThemeImportModal>
export default meta

type Story = StoryObj<typeof meta>

/** Empty: Import stays disabled until there is a link. */
export const Default: Story = {}

/** A pasted text that is not an editor link, after Import: the error under the link. */
export const Error: Story = {
  play: async () => {
    await userEvent.type(
      await screen.findByPlaceholderText('https://ui.nuxt.com/theme?doc=…'),
      'my nice theme',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText(/Paste the share link from ui.nuxt.com\/theme/)
  },
}

/** A name a built-in theme already has: the help says which name it will be saved under. */
export const NameTaken: Story = {
  play: async () => {
    await userEvent.type(await screen.findByPlaceholderText('My theme'), 'Mono')
  },
}
