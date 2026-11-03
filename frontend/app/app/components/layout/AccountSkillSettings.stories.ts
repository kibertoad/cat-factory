import type { Meta, StoryObj } from '@storybook/vue3'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { skillLibraryApi } from '~/stories/skillsApi'
import { accountSkills, skillSource } from '~/stories/skills.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import AccountSkillSettings from './AccountSkillSettings.vue'

// The account's Skills tab: a line on what skills are, above the account's skill library. The
// library loads the account's skills and probes GitHub when it opens, so each story answers those
// reads. The library's other states are in `SkillLibraryManager`'s stories.
const meta = {
  title: 'Settings/Components/AccountSkillSettings',
  component: AccountSkillSettings,
  args: { accountId: orgAccount.id },
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: [
      ...skillLibraryApi({ skills: accountSkills, sources: [skillSource] }),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof AccountSkillSettings>
export default meta

type Story = StoryObj<typeof meta>

/** Three synced skills and the repository they came from. */
export const Default: Story = {}

/** Nothing synced and nothing linked. */
export const Empty: Story = {
  parameters: { api: [...skillLibraryApi(), ...githubProbeApi()] },
}

/** The catalog read failed: the note that the library is off. */
export const Unavailable: Story = {
  parameters: { api: [...skillLibraryApi({ available: false }), ...githubProbeApi()] },
}
