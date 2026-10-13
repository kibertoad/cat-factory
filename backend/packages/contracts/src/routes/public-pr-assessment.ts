import { defineApiContract } from '@toad-contracts/valibot'
import { assessPublicPullRequestSchema, publicPrAssessmentSchema } from '../pr-assessment.js'
import { errorResponses, withMinScope } from './_shared.js'

/**
 * Score a pull request on the merger's three axes and say whether a risk policy would let it land
 * with no person. `write`, because it spends model budget. Synchronous: one inline model call, no
 * run, nothing persisted.
 *
 * Role-scoped policy rules (`classRulesByRole`, `dryRunRoles`, `submissionClassesByRole`) do not
 * apply: an API key carries no workspace role, exactly as for a task it creates.
 */
export const assessPublicPullRequestContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/pr-assessments',
    requestBodySchema: assessPublicPullRequestSchema,
    responsesByStatusCode: { 200: publicPrAssessmentSchema, ...errorResponses },
  }),
)
