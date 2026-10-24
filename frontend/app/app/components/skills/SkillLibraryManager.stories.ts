import type { Meta, StoryObj } from '@storybook/vue3'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { skillLibraryApi } from '~/stories/skillsApi'
import { accountSkills, skillSource } from '~/stories/skills.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import SkillLibraryManager from './SkillLibraryManager.vue'

// An account's skill library: the skills synced from its repositories (each with its group, its
// resource files and the commit it is pinned to), the linked repositories with check, resync and
// unlink, and the form that links one. With the GitHub App connected the form searches a
// repository and browses to the skills folder; without it, the owner, name and folder are typed.
// The manager loads the account's library and probes GitHub when it opens, so each story answers
// those reads.
const meta = {
  title: 'Settings/Components/SkillLibraryManager',
  component: SkillLibraryManager,
  args: { accountId: orgAccount.id },
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: [
      ...skillLibraryApi({ skills: accountSkills, sources: [skillSource] }),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof SkillLibraryManager>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three synced skills, one of them filed under Other because its manifest declares a group this
 * build does not know, and the playbooks repository they came from.
 */
export const Default: Story = {}

/** Nothing synced and nothing linked. */
export const Empty: Story = {
  parameters: { api: [...skillLibraryApi(), ...githubProbeApi()] },
}

/** The catalog read failed, which the manager reads as the library being off: a note only. */
export const Unavailable: Story = {
  parameters: { api: [...skillLibraryApi({ available: false }), ...githubProbeApi()] },
}

/** The sources read failed: the catalog shows, and a note replaces the link form. */
export const SourcesUnavailable: Story = {
  parameters: {
    api: [
      ...skillLibraryApi({ skills: accountSkills, sourcesAvailable: false }),
      ...githubProbeApi(),
    ],
  },
}

/** GitHub is not connected on this board: the owner, name and folder are typed. */
export const ManualEntry: Story = {
  parameters: {
    api: [
      ...skillLibraryApi({ skills: accountSkills, sources: [skillSource] }),
      ...githubProbeApi({ connected: false }),
    ],
  },
}
