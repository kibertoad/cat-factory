import type { Meta, StoryObj } from '@storybook/vue3'
import { screen } from 'storybook/test'
import { withSeed } from '~/stories/withStores'
import TranslationWarningBanner from './TranslationWarningBanner.vue'

// The strip at the top of the shell in any language but English: the translations may be wrong,
// and the link leads to the repository to report it. It shows only while the locale is not `en`
// and the user has not dismissed it for that locale (kept in this browser's storage), so the seed
// clears the dismissal and switches this story's app to Spanish.
const DISMISSED_KEY = 'cat-factory:translation-warning-dismissed'

const meta = {
  title: 'Shell/Components/TranslationWarningBanner',
  component: TranslationWarningBanner,
  parameters: { layout: 'fullscreen' },
  decorators: [
    withSeed(() => {
      try {
        window.localStorage.removeItem(DISMISSED_KEY)
      } catch {
        // Blocked storage keeps no dismissal either.
      }
      void useNuxtApp().$i18n.setLocale('es')
    }),
  ],
} satisfies Meta<typeof TranslationWarningBanner>
export default meta

type Story = StoryObj<typeof meta>

/** Spanish: the warning, the repository link and the dismiss button. */
export const Default: Story = {
  // The Spanish catalog loads on demand, after the seed asks for it, so the wait is long.
  play: async () => {
    await screen.findByText('Traducción no oficial', {}, { timeout: 5000 })
  },
}
