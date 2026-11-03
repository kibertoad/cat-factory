import type { Meta, StoryObj } from '@storybook/vue3'
import type { InitiativePresetDescriptor } from '@cat-factory/contracts'
import { probeInitiativePresetContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useInitiativesStore } from '~/stores/initiative'
import { useUiStore } from '~/stores/ui'
import CreateInitiativeModal from './CreateInitiativeModal.vue'

// The form that creates an initiative under a service frame. The user picks a preset, fills the
// preset's own fields and names the goal. A preset with a repo probe prefills its fields from the
// frame's repository when it is picked. The presets below are copies of the built-in ones
// (`initiative-preset-registry.ts` in kernel, `presets/*/preset.ts` in agents); the migration
// preset's fields are left out, because no story picks it. Create sends a request no story
// answers.
const meta = {
  title: 'Board/Components/CreateInitiativeModal',
  component: CreateInitiativeModal,
} satisfies Meta<typeof CreateInitiativeModal>
export default meta

type Story = StoryObj<typeof meta>

const genericPreset: InitiativePresetDescriptor = {
  id: 'preset_generic',
  presentation: {
    label: 'Custom initiative',
    icon: 'i-lucide-git-branch-plus',
    color: '#6366f1',
    description:
      'Plan an open-ended body of work through a guided interview, then execute it as a loop of tasks.',
  },
  fields: [],
  planningPipelineId: 'pl_initiative',
  interview: 'full',
  humanReviewDefault: true,
  defaultFragmentIds: [],
}

const docsRefreshPreset: InitiativePresetDescriptor = {
  id: 'preset_docs_refresh',
  presentation: {
    label: 'Documentation refresh',
    icon: 'i-lucide-book-open-text',
    color: '#0ea5e9',
    description:
      'Audit a service’s documentation against its code and drive it to a full, current set — READMEs, diagrams, in-source comments and business rules — mostly unattended.',
  },
  fields: [
    {
      key: 'docTypes',
      label: 'Documentation to refresh',
      help: 'Which kinds of documentation to audit and bring current.',
      type: 'checkbox-group',
      options: [
        { value: 'readme', label: 'README files' },
        { value: 'diagrams', label: 'Architecture & flow diagrams (Mermaid)' },
        { value: 'comments', label: 'In-source code comments' },
        { value: 'business-rules', label: 'Business rules & domain constraints' },
      ],
      defaultValues: ['readme', 'diagrams', 'comments', 'business-rules'],
    },
    {
      key: 'placementMode',
      label: 'Documentation placement',
      help: 'Where docs live: one root tree, or per-service (monorepo). Autodetected from the repo.',
      type: 'select',
      options: [
        { value: 'root', label: 'Single root docs tree' },
        { value: 'per-service', label: 'Per-service docs (monorepo)' },
      ],
      default: 'root',
    },
    {
      key: 'docsRoot',
      label: 'Docs root',
      help: 'The repo-relative directory documentation is written under.',
      type: 'path',
      default: 'docs',
    },
    {
      key: 'diagramsDir',
      label: 'Diagrams directory',
      type: 'path',
      default: 'docs/diagrams',
      showWhen: { key: 'docTypes', includes: 'diagrams' },
    },
    {
      key: 'businessRulesDir',
      label: 'Business-rules directory',
      type: 'path',
      default: 'docs/business-logic',
      showWhen: { key: 'docTypes', includes: 'business-rules' },
    },
    {
      key: 'scopeHint',
      label: 'Scope (optional)',
      help: 'Which services or areas to focus on. Leave blank to cover everything in the frame.',
      type: 'textarea',
      placeholder: 'e.g. the billing and notifications services only',
    },
    {
      key: 'humanReview',
      label: 'Review each documentation change before it merges',
      help: 'Off by default — documentation PRs merge automatically once CI is green. Turn on to pause each spawned task for approval.',
      type: 'checkbox',
    },
    {
      key: 'styleFragments',
      label: 'Writing-style guidance',
      help: 'Best-practice writing fragments folded into every documentation task.',
      type: 'checkbox-group',
      options: [
        { value: 'style.anti-llmisms', label: 'Avoid LLM tells' },
        { value: 'style.concise-actionable', label: 'Concise and actionable' },
      ],
      defaultValues: ['style.anti-llmisms', 'style.concise-actionable'],
    },
  ],
  planningPipelineId: 'pl_initiative_docs',
  interview: 'skip',
  humanReviewDefault: false,
  defaultFragmentIds: ['style.anti-llmisms', 'style.concise-actionable'],
  probe: true,
}

const techMigrationPreset: InitiativePresetDescriptor = {
  id: 'preset_tech_migration',
  presentation: {
    label: 'Technological migration',
    icon: 'i-lucide-database-zap',
    color: '#f59e0b',
    description:
      'Swap a load-bearing technology (database, framework major, runtime) behind a behaviour-preservation safety net: blast zone → coverage → transition design → delivery → decommission.',
  },
  fields: [],
  planningPipelineId: 'pl_initiative',
  interview: 'full',
  humanReviewDefault: true,
  defaultFragmentIds: [],
}

/** Open the form on the Auth Service frame, with `presets` registered. */
function withForm(presets: InitiativePresetDescriptor[]) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    useInitiativesStore().presets = presets
    useUiStore().openCreateInitiative(authService.id)
  })
}

/**
 * Only the built-in preset, so there is no picker: the frame, title, goal, the attachments and the
 * hint. With nothing connected, the attachments section offers no picker.
 */
export const Default: Story = {
  decorators: [withForm([genericPreset])],
}

/** Three presets: the picker, with Custom initiative selected. */
export const PresetPicker: Story = {
  decorators: [withForm([genericPreset, docsRefreshPreset, techMigrationPreset])],
}

/**
 * Documentation refresh picked: its own fields, with the placement fields prefilled by the repo
 * probe, which found the docs under `documentation/` instead of the default `docs/`.
 */
export const PresetFields: Story = {
  decorators: [withForm([genericPreset, docsRefreshPreset, techMigrationPreset])],
  parameters: {
    api: [
      apiResponse(probeInitiativePresetContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { presetId: docsRefreshPreset.id },
        body: {
          placementMode: 'root',
          docsRoot: 'documentation',
          diagramsDir: 'documentation/diagrams',
          businessRulesDir: 'documentation/business-logic',
        },
      }),
    ],
  },
  play: async () => {
    await userEvent.click(
      await screen.findByTestId(`initiative-preset-option-${docsRefreshPreset.id}`),
    )
    // The fields are below the modal body's fold, so bring the prefilled ones into view.
    const docsRoot = await screen.findByDisplayValue('documentation')
    docsRoot.scrollIntoView({ block: 'center' })
  },
}
