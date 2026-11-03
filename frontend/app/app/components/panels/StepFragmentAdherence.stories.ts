import type { Meta, StoryObj } from '@storybook/vue3'
import StepFragmentAdherence from './StepFragmentAdherence.vue'

// A review step's rating (1 to 10) of the change against each best-practice standard in its
// prompt, with the issues each standard surfaced. The bar takes the error colour below 5, the
// warning colour from 5 and the success colour from 8. A row with no title or id is labelled
// "Standard"; an empty list renders nothing.
const item = (
  title: string,
  rating: number,
  assessment: string,
  relatedFindings: string[] = [],
) => ({
  fragmentId: title.toLowerCase().replaceAll(' ', '-'),
  title,
  rating,
  assessment,
  relatedFindings,
})

const meta = {
  title: 'Pipeline/Components/StepFragmentAdherence',
  component: StepFragmentAdherence,
  parameters: { width: 'panel' },
} satisfies Meta<typeof StepFragmentAdherence>
export default meta

type Story = StoryObj<typeof meta>

/** One standard per band, so the three bar colours are visible together. */
export const Default: Story = {
  args: {
    items: [
      item('Error handling', 9, 'Every rejected path carries its cause through to the funnel.'),
      item('Test coverage', 6, 'The happy path is covered; the expiry race is not.', [
        'No test drives two tabs refreshing at once',
      ]),
      item('Naming', 3, 'Two helpers named `refresh` in one file, doing different things.', [
        '`refresh` in session.ts shadows the transport one',
        'The new flag reads as a noun',
      ]),
    ],
  },
}

/** The band edges: 4, 5 and 8. */
export const BandBoundaries: Story = {
  args: {
    items: [
      item('Last poor', 4, 'The highest poor rating.'),
      item('First partial', 5, 'The lowest partial rating.'),
      item('First strong', 8, 'The lowest strong rating.'),
    ],
  },
}

/** What the schema falls back to: no title or id, no prose, a rating of 5. */
export const Degraded: Story = {
  args: { items: [{ rating: 5, assessment: '', relatedFindings: [] }] },
}
