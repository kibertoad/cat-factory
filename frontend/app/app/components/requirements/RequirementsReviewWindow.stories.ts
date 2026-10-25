import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getRequirementReviewContract,
  type RequirementRecommendation,
  type RequirementReview,
  type RequirementReviewItem,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent, within } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { loginTask } from '~/stories/board.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import RequirementsReviewWindow from './RequirementsReviewWindow.vue'

// The requirements review of the login task: the reviewer's findings on the product and business
// layer, split into the ones only a person can decide and the ones that follow from good practice,
// with what still wants a reaction at the top of each. A person answers or dismisses each, then
// the answers are folded into one requirements document that every later step reads. The fold and
// the re-review run in the background. The window asks for the review when it opens, so each story
// answers that read. The findings and the document are made up. Every button sends a request no
// story answers.

const created = Date.UTC(2026, 9, 14, 8, 45)

function item(
  overrides: Partial<RequirementReviewItem> & Pick<RequirementReviewItem, 'id' | 'title'>,
): RequirementReviewItem {
  return {
    category: 'clarification',
    severity: 'medium',
    detail: '',
    status: 'open',
    reply: null,
    autoAnswerable: false,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }
}

const rememberMe = item({
  id: 'rq_remember',
  severity: 'high',
  category: 'gap',
  title: 'How long does "Remember me" keep a user signed in?',
  detail: 'The task asks for the option but gives no duration.',
})
const lockout = item({
  id: 'rq_lockout',
  category: 'question',
  title: 'Do failed sign-ins lock the account?',
  detail: 'Other Acme services lock after five failures. The task does not say.',
  status: 'answered',
  reply: 'Yes, as in the other services.',
})
const sso = item({
  id: 'rq_sso',
  severity: 'low',
  category: 'assumption',
  title: 'SSO users sign in on this page too',
  detail: 'The page shows only a password form.',
  status: 'dismissed',
})
const passwordRules = item({
  id: 'rq_password_rules',
  category: 'risk',
  autoAnswerable: true,
  title: 'The task sets no minimum password length',
  detail: 'Common practice is at least 12 characters, checked against known breached passwords.',
})
const errorCopy = item({
  id: 'rq_error_copy',
  severity: 'low',
  autoAnswerable: true,
  title: 'The error for a wrong password names the field',
  detail: 'Saying which field was wrong tells an attacker the email exists.',
  status: 'answered',
  reply: 'Use one message for both: "The email or password is wrong."',
})

const items = [rememberMe, lockout, sso, passwordRules, errorCopy]

function review(overrides: Partial<RequirementReview> = {}): RequirementReview {
  return {
    id: 'rqr_login',
    blockId: loginTask.id,
    status: 'ready',
    items,
    model: 'claude-sonnet-5-5',
    incorporatedRequirements: null,
    iteration: 1,
    maxIterations: 3,
    recommendations: [],
    rev: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }
}

const incorporated = `A user signs in with an email and a password.

## Remember me

"Remember me" keeps the user signed in for 30 days on that device.

## Failed sign-ins

Five failed sign-ins lock the account for 15 minutes, as in the other Acme services.

## Passwords

A password has at least 12 characters and is not on the list of known breached passwords.

## Errors

A wrong email or password shows one message: "The email or password is wrong."`

/** Every finding with an answer: the open ones answered as the document has them. */
const answered = items.map((i) =>
  i.status === 'open'
    ? {
        ...i,
        status: 'answered' as const,
        reply: i.id === rememberMe.id ? 'Thirty days.' : 'At least 12 characters.',
      }
    : i,
)

const read = { pathPrefix: storyWorkspacePrefix, pathParams: { blockId: loginTask.id } }

/** The window open on the login task, with `answer` for the read of its review. */
function opened(answer: HttpHandler): Story {
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(snapshot())
        seedResultView({
          view: 'requirements-review',
          blockId: loginTask.id,
          instanceId: null,
          stepIndex: null,
        })
      }),
    ],
    parameters: { api: [answer] },
  }
}

function story(body: RequirementReview | null): Story {
  return opened(apiResponse(getRequirementReviewContract, { ...read, body }))
}

const meta = {
  title: 'Pipeline/Pages/RequirementsReviewWindow',
  component: RequirementsReviewWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RequirementsReviewWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Five findings in two groups, the ones a person decides first, each with what still wants a
 * reaction above what is settled, and Incorporate answers in the rail.
 */
export const Default: Story = story(review())

/** The task has no requirements review. */
export const Empty: Story = story(null)

/** The read of the review has not answered. */
export const Loading: Story = opened(apiPending(getRequirementReviewContract, read))

/** The read failed: the window says so with a retry, not the no-review empty state. */
export const Failed: Story = {
  ...opened(apiFailure(getRequirementReviewContract, read)),
  play: async () => {
    await screen.findByTestId('load-failed-state')
  },
}

/**
 * The answers are folded into a draft document, open below the findings, waiting for a person to
 * re-review it or redo the fold.
 */
export const Merged: Story = story(
  review({ status: 'merged', items: answered, incorporatedRequirements: incorporated }),
)

/** The re-review raised new findings on its third and last round: the cap prompt. */
export const Exceeded: Story = story(review({ status: 'exceeded', iteration: 3 }))

/** The answers are being folded in the background, so nothing can be edited. */
export const Incorporating: Story = story(review({ status: 'incorporating', items: answered }))

/** The requirements are settled: the findings resolved and the document they made. */
export const Incorporated: Story = story(
  review({
    status: 'incorporated',
    iteration: 2,
    incorporatedRequirements: incorporated,
    items: answered.map((i) => (i.status === 'answered' ? { ...i, status: 'resolved' } : i)),
  }),
)

function recommendation(
  finding: RequirementReviewItem,
  overrides: Partial<RequirementRecommendation> & Pick<RequirementRecommendation, 'id'>,
): RequirementRecommendation {
  return {
    sourceFinding: { title: finding.title, detail: finding.detail, itemId: finding.id },
    recommendedText: '',
    status: 'ready',
    note: null,
    groundedInFragment: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }
}

/**
 * The Requirement Writer at work: a suggestion still being written for "Remember me", one ready to
 * accept or reject for the lockout, one drawn from the team's standard for the error copy, and the
 * password length pre-answered by the automation as a recommended default.
 */
export const Recommendations: Story = story(
  review({
    items: [
      { ...rememberMe, status: 'recommend_requested' },
      { ...lockout, status: 'recommend_requested', reply: null },
      sso,
      {
        ...passwordRules,
        status: 'answered',
        reply: 'At least 12 characters, checked against known breached passwords.',
      },
      { ...errorCopy, status: 'recommend_requested', reply: null },
    ],
    recommendations: [
      recommendation(rememberMe, { id: 'rec_remember', status: 'pending' }),
      recommendation(lockout, {
        id: 'rec_lockout',
        recommendedText: 'Lock the account for 15 minutes after five failed sign-ins.',
        groundedIn: 'web',
        confidence: 0.55,
      }),
      recommendation(errorCopy, {
        id: 'rec_error_copy',
        recommendedText: 'Show one message for a wrong email or password.',
        groundedInFragment: { id: 'frag_auth_errors', title: 'Authentication errors' },
        confidence: 0.92,
      }),
      recommendation(passwordRules, {
        id: 'rec_password_rules',
        auto: true,
        status: 'accepted',
        recommendedText: 'At least 12 characters, checked against known breached passwords.',
        groundedIn: 'standard',
        confidence: 0.88,
      }),
    ],
  }),
)

/**
 * Recommend chosen on the open "Remember me" finding: the guidance box in place of the answer, and
 * Request recommendations in the rail.
 */
export const RecommendChosen: Story = {
  ...story(review()),
  play: async () => {
    const card = (await screen.findAllByTestId('requirements-finding'))[0]!
    await userEvent.click(within(card).getByTestId('requirements-mode-recommend'))
    await within(card).findByPlaceholderText('Guidance for the recommendation (optional)…')
  },
}
