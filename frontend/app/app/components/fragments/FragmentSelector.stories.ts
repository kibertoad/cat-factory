import type { Meta, StoryObj } from '@storybook/vue3'
import { resolvedFragmentsContract } from '@cat-factory/contracts'
import { ref, watch } from 'vue'
import { screen, userEvent, within } from 'storybook/test'
import { accounts } from '~/stories/accounts.stories.mocks'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { fragmentCatalog } from '~/stories/fragments.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import FragmentSelector from './FragmentSelector.vue'

// The best-practice fragment picker that the add-task form, the task inspector and the service
// inspector share: the chosen fragments as badges, and a popover that lists the pool by
// category. A row toggles and the list stays open; Done closes it. A badge click removes it. The
// selection is a `v-model`, so the stories keep it in a local ref. The label and the empty line
// are the ones the task inspector passes. The picker loads the catalog on mount to name the
// chosen ids.
const meta = {
  title: 'Inspector/Components/FragmentSelector',
  component: FragmentSelector,
  args: {
    modelValue: ['node.performance', 'node.best-practices'],
    pool: fragmentCatalog,
    label: 'Best practices',
    emptyText: 'None. Agents follow their default guidance.',
  },
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'panel',
    api: [
      apiResponse(resolvedFragmentsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: fragmentCatalog,
      }),
    ],
  },
  render: (args) => ({
    components: { FragmentSelector },
    setup() {
      const selected = ref(args.modelValue)
      // Keeps the local model in step with the Controls panel.
      watch(
        () => args.modelValue,
        (value) => (selected.value = value),
      )
      return { args, selected }
    },
    template: '<div class="pb-96"><FragmentSelector v-bind="args" v-model="selected" /></div>',
  }),
} satisfies Meta<typeof FragmentSelector>
export default meta

type Story = StoryObj<typeof meta>

async function openPicker(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId('fragment-add'))
}

/** Open the picker, then wait for what the story shows. The popover is teleported to `body`. */
function opensTo(shown: () => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openPicker(canvasElement)
    await shown()
  }
}

/** Two fragments chosen, as badges under the label. */
export const Default: Story = {}

/** Nothing chosen: the empty line. */
export const Empty: Story = { args: { modelValue: [] } }

/**
 * The picker open: the pool by category, the two chosen rows checked, and the link to the
 * board's fragment library. With no accounts there is no account link.
 */
export const Open: Story = {
  play: opensTo(() => screen.findByTestId('fragment-option-node.performance')),
}

/** An empty pool: the picker says there are no fragments, and still links to the library. */
export const OpenEmptyPool: Story = {
  args: { modelValue: [], pool: [] },
  play: opensTo(() => screen.findByText('No fragments available.')),
}

/** A chosen id the catalog no longer has: the badge shows the raw id, and it is still removable. */
export const UnknownId: Story = {
  args: { modelValue: ['node.performance', 'acme.retired-rule'] },
}

/** Accounts are on, so the picker also links to the account's fragments. */
export const WithAccountLink: Story = {
  decorators: [
    withSeed(() => {
      useAccountsStore().accounts = accounts
    }),
  ],
  play: opensTo(() => screen.findByText('Manage account fragments…')),
}
