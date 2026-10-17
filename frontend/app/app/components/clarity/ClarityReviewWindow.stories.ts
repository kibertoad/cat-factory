import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getClarityReviewContract,
  type ClarityReview,
  type ClarityReviewItem,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardWith } from '~/stories/board.stories.mocks'
import { lockoutTask } from '~/stories/lanes.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import ClarityReviewWindow from './ClarityReviewWindow.vue'

// The clarity review of a bug report, the lockout bug: the reviewer's findings, most severe
// first, each answered or dismissed by a person, then folded into a clarified report that the
// investigator and the coder read in place of the description. The fold and the re-review run in
// the background. The window asks for the review when it opens, so each story answers that read.
// The findings and the report are made up. Every button sends a request no story answers.

const created = Date.UTC(2026, 9, 14, 9, 30)

function item(
  overrides: Partial<ClarityReviewItem> & Pick<ClarityReviewItem, 'id' | 'title'>,
): ClarityReviewItem {
  return {
    category: 'clarification',
    severity: 'medium',
    detail: '',
    status: 'open',
    reply: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }
}

const items: ClarityReviewItem[] = [
  item({
    id: 'cl_counter_scope',
    severity: 'high',
    category: 'gap',
    title: 'Is the counter per account or per account and IP address?',
    detail:
      'The report says "five failed sign-ins". An attacker from many addresses counts once each.',
  }),
  item({
    id: 'cl_unlock',
    category: 'question',
    title: 'How does a locked account unlock?',
    detail: 'The report does not say whether the lock expires or needs support.',
    status: 'answered',
    reply: 'It unlocks after 15 minutes, or with a password reset.',
  }),
  item({
    id: 'cl_sso',
    severity: 'low',
    category: 'assumption',
    title: 'The lockout applies to SSO sign-ins too',
    detail: 'SSO users never enter a password here.',
    status: 'dismissed',
  }),
]

function review(overrides: Partial<ClarityReview> = {}): ClarityReview {
  return {
    id: 'clr_lockout',
    blockId: lockoutTask.id,
    status: 'ready',
    items,
    model: 'claude-sonnet-5-5',
    clarifiedReport: null,
    iteration: 1,
    maxIterations: 3,
    rev: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }
}

const clarified = `Lock an account after five failed sign-ins **for that account**, from any address.

## Unlock

The lock expires after 15 minutes. A password reset unlocks it at once.

## Out of scope

SSO sign-ins, which never reach the password check.`

const read = { pathPrefix: storyWorkspacePrefix, pathParams: { blockId: lockoutTask.id } }

/** The window open on the lockout bug, with `answer` for the read of its review. */
function opened(answer: HttpHandler): Story {
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(snapshot({ blocks: boardWith(lockoutTask) }))
        seedResultView({
          view: 'clarity-review',
          blockId: lockoutTask.id,
          instanceId: null,
          stepIndex: null,
        })
      }),
    ],
    parameters: { api: [answer] },
  }
}

function story(body: ClarityReview | null): Story {
  return opened(apiResponse(getClarityReviewContract, { ...read, body }))
}

const meta = {
  title: 'Pipeline/Pages/ClarityReviewWindow',
  component: ClarityReviewWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ClarityReviewWindow>
export default meta

type Story = StoryObj<typeof meta>

/** Three findings: one open, one answered and one dismissed, with Incorporate answers. */
export const Default: Story = story(review())

/** The bug has no clarity review. */
export const Empty: Story = story(null)

/** The read of the review has not answered. */
export const Loading: Story = opened(apiPending(getClarityReviewContract, read))

/** The answers are folded into a draft report, waiting for a person to accept it or redo it. */
export const Merged: Story = story(
  review({
    status: 'merged',
    clarifiedReport: clarified,
    items: items.map((i) =>
      i.status === 'open' ? { ...i, status: 'answered', reply: 'Per account.' } : i,
    ),
  }),
)

/** The re-review found new gaps on its third and last round: the cap prompt. */
export const Exceeded: Story = story(review({ status: 'exceeded', iteration: 3 }))

/** The answers are being folded in the background, so nothing can be edited. */
export const Incorporating: Story = story(review({ status: 'incorporating' }))

/** The report is clarified: the findings are settled and the clarified report is shown. */
export const Incorporated: Story = story(
  review({
    status: 'incorporated',
    iteration: 2,
    clarifiedReport: clarified,
    items: items.map((i) =>
      i.status === 'open'
        ? { ...i, status: 'resolved', reply: 'Per account, from any address.' }
        : i,
    ),
  }),
)
