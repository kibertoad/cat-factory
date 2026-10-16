import type { Meta, StoryObj } from '@storybook/vue3'
import type { RequirementItem, ServiceSpecView, SpecDoc } from '@cat-factory/contracts'
import { getServiceSpecContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import ServiceSpecWindow from './ServiceSpecWindow.vue'

// A service's specification, read from its repository's default branch: modules and their
// feature groups on the left, and the selected group's requirements, acceptance criteria and
// domain rules on the right. Each requirement says whether the service is observed to honour it
// (established) or it is agreed and not built yet (aspirational), and a filter shows one half.
// With feature files on the branch, a toggle shows the group's Gherkin instead. The window opens
// on the first group and loads the spec when it opens, so each story answers that read. The spec
// is made up; its feature files are rendered from it the way the backend renders them
// (`renderSpecFeatureFiles` in agents).

function requirement(
  id: string,
  title: string,
  statement: string,
  overrides: Partial<RequirementItem> = {},
): RequirementItem {
  return {
    id,
    title,
    statement,
    kind: 'functional',
    priority: 'must',
    state: 'aspirational',
    sourceBlockIds: [],
    acceptance: [],
    ...overrides,
  }
}

const spec: SpecDoc = {
  service: 'Auth Service',
  summary:
    'Signs people in, keeps their sessions alive and ends them. Every other Acme service ' +
    'trusts the access tokens it issues.',
  modules: [
    {
      name: 'Sessions',
      summary: '',
      groups: [
        {
          name: 'Refresh tokens',
          summary: 'How a session stays alive without a new sign-in.',
          requirements: [
            requirement(
              'req-refresh-rotate',
              'Rotate refresh tokens on use',
              'The system SHALL issue a new refresh token on every refresh and revoke the one ' +
                'that was used.',
              {
                state: 'established',
                sourceBlockIds: ['task_refresh'],
                acceptance: [
                  {
                    id: 'ac-refresh-rotate-1',
                    given: 'a signed-in user with refresh token A',
                    when: 'the client refreshes with A',
                    outcome: 'the response carries a new token B and A is revoked',
                  },
                ],
              },
            ),
            requirement(
              'req-refresh-reuse',
              'Revoke the family on reuse',
              'The system SHALL revoke every token in a family when a revoked token is used.',
              {
                acceptance: [
                  {
                    id: 'ac-refresh-reuse-1',
                    given: 'refresh token A was rotated to B',
                    when: 'the client refreshes with A',
                    outcome: 'the request is refused and B is revoked',
                  },
                  {
                    id: 'ac-refresh-reuse-2',
                    given: 'two refreshes with token A arrive at once',
                    when: 'both are processed',
                    outcome: 'at most one succeeds',
                  },
                ],
              },
            ),
            requirement(
              'req-refresh-latency',
              'Refresh latency',
              'A refresh SHALL complete within 150 ms at the 99th percentile.',
              { kind: 'nonfunctional', priority: 'should' },
            ),
          ],
          rules: [
            {
              id: 'rule-one-live-token',
              rule: 'A token family has at most one live refresh token.',
              rationale: 'Two live tokens mean a copy is in use somewhere.',
              sourceBlockIds: [],
            },
          ],
        },
        {
          name: 'Sign-out',
          summary: '',
          requirements: [
            requirement(
              'req-logout-everywhere',
              'Log out everywhere',
              'The system SHALL let a user revoke every session they hold except the current one.',
              {
                priority: 'should',
                acceptance: [
                  {
                    id: 'ac-logout-everywhere-1',
                    given: 'a user signed in on a phone and a laptop',
                    when: 'they log out everywhere from the laptop',
                    outcome: 'the phone session is revoked and the laptop stays signed in',
                  },
                ],
              },
            ),
          ],
          rules: [],
        },
      ],
    },
    {
      name: 'Sign-in',
      summary: '',
      groups: [
        {
          name: 'Rate limiting',
          summary: '',
          requirements: [
            requirement(
              'req-login-rate-limit',
              'Limit failed sign-ins',
              'The system SHALL refuse sign-in for 15 minutes after five failures from one ' +
                'address.',
              { kind: 'constraint', state: 'established' },
            ),
          ],
          rules: [],
        },
      ],
    },
    { name: 'Audit', summary: '', groups: [] },
  ],
}

/** The `.feature` files for the two groups that carry acceptance criteria. */
const features: ServiceSpecView['features'] = [
  {
    module: 'Sessions',
    group: 'Refresh tokens',
    path: 'spec/features/sessions/refresh-tokens.feature',
    content: [
      'Feature: Sessions — Refresh tokens',
      '  How a session stays alive without a new sign-in.',
      '',
      '  # requirement: req-refresh-rotate',
      '  @must',
      '  Scenario: Rotate refresh tokens on use',
      '    Given a signed-in user with refresh token A',
      '    When the client refreshes with A',
      '    Then the response carries a new token B and A is revoked',
      '',
      '  # requirement: req-refresh-reuse',
      '  @must @aspirational',
      '  Scenario: Revoke the family on reuse (#1)',
      '    Given refresh token A was rotated to B',
      '    When the client refreshes with A',
      '    Then the request is refused and B is revoked',
      '',
      '  # requirement: req-refresh-reuse',
      '  @must @aspirational',
      '  Scenario: Revoke the family on reuse (#2)',
      '    Given two refreshes with token A arrive at once',
      '    When both are processed',
      '    Then at most one succeeds',
      '',
    ].join('\n'),
  },
  {
    module: 'Sessions',
    group: 'Sign-out',
    path: 'spec/features/sessions/sign-out.feature',
    content: [
      'Feature: Sessions — Sign-out',
      '',
      '  # requirement: req-logout-everywhere',
      '  @aspirational',
      '  Scenario: Log out everywhere',
      '    Given a user signed in on a phone and a laptop',
      '    When they log out everywhere from the laptop',
      '    Then the phone session is revoked and the laptop stays signed in',
      '',
    ].join('\n'),
  },
]

function specIs(body: ServiceSpecView) {
  return apiResponse(getServiceSpecContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { blockId: authService.id },
    body,
  })
}

const meta = {
  title: 'Documents/Components/ServiceSpecWindow',
  component: ServiceSpecWindow,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
      useUiStore().openServiceSpec(authService.id)
    }),
  ],
  parameters: {
    api: [
      specIs({
        present: true,
        spec,
        features,
        diagnostics: { anchor: 'present', issues: [] },
      }),
    ],
  },
} satisfies Meta<typeof ServiceSpecWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The first group, Refresh tokens: one of three requirements established, each with its state,
 * priority and kind, the acceptance criteria, and a domain rule.
 */
export const Default: Story = {}

/** The spec read in flight: placeholder rows for the tree and the detail. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(getServiceSpecContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: authService.id },
      }),
    ],
  },
}

/** The read failed: a message and Retry. */
export const LoadFailed: Story = {
  parameters: {
    api: [
      apiFailure(getServiceSpecContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: authService.id },
      }),
    ],
  },
}

/** No spec on the default branch yet. */
export const Empty: Story = {
  parameters: {
    api: [
      specIs({
        present: false,
        spec: null,
        features: [],
        diagnostics: { anchor: 'absent', issues: [] },
      }),
    ],
  },
}

/**
 * The provider failed to read the spec's anchor file, so the backend cannot say whether a spec
 * exists. The window does not read the diagnostics, so this shows the same empty state as no
 * spec.
 */
export const AnchorReadFailed: Story = {
  parameters: {
    api: [
      specIs({
        present: false,
        spec: null,
        features: [],
        diagnostics: {
          anchor: 'read_failed',
          issues: [{ path: 'spec/service.json', kind: 'read_failed', dropped: 0 }],
        },
      }),
    ],
  },
}

/** The overview: the summary and how many requirements are established against aspirational. */
export const Overview: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Overview' }))
    await screen.findByTestId('spec-state-rollup')
  },
}

/** Established only, on a group with none: the filter says nothing matches and offers All. */
export const FilteredToNone: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Sign-out/ }))
    await userEvent.click(await screen.findByTestId('spec-state-filter-established'))
    await screen.findByTestId('spec-state-filter-empty')
  },
}

/** The Gherkin toggle: the group's feature file, with its tags. */
export const Gherkin: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Gherkin' }))
    await screen.findByText(/Feature: Sessions — Refresh tokens/)
  },
}
