import type { Meta, StoryObj } from '@storybook/vue3'
import { ref, watch } from 'vue'
import type { Recurrence } from '~/types/recurring'
import RecurrenceEditor from './RecurrenceEditor.vue'

// When a recurring task runs: every N hours, on the chosen weekdays, optionally only inside an
// hour window, in a timezone. The editor is controlled; the render keeps the value, so a click
// changes what the story shows.
const meta = {
  title: 'Inspector/Components/RecurrenceEditor',
  component: RecurrenceEditor,
  parameters: { width: 'panel' },
  args: {
    modelValue: {
      intervalHours: 6,
      weekdays: [1, 2, 3, 4, 5],
      windowStartHour: 9,
      windowEndHour: 17,
      timezone: 'Europe/London',
    },
  },
  render: (args) => ({
    components: { RecurrenceEditor },
    setup() {
      const value = ref<Recurrence>(args.modelValue)
      // Keeps the local model in step with the Controls panel.
      watch(
        () => args.modelValue,
        (next) => (value.value = next),
      )
      return { value }
    },
    template: '<RecurrenceEditor v-model="value" />',
  }),
} satisfies Meta<typeof RecurrenceEditor>
export default meta

type Story = StoryObj<typeof meta>

/** Every 6 hours on weekdays, between 09:00 and 17:00 London time. */
export const Default: Story = {}

/** Any hour: no window, so the two hour selects are hidden. */
export const AnyHour: Story = {
  args: {
    modelValue: {
      intervalHours: 24,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      windowStartHour: null,
      windowEndHour: null,
      timezone: 'UTC',
    },
  },
}

/** A timezone outside the built-in list, added to the options. */
export const CustomTimezone: Story = {
  args: {
    modelValue: {
      intervalHours: 12,
      weekdays: [1, 3, 5],
      windowStartHour: 8,
      windowEndHour: 20,
      timezone: 'America/Sao_Paulo',
    },
  },
}
