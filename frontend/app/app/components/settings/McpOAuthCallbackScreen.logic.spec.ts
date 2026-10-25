import { describe, expect, it } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { describeCallbackFailure } from '~/components/settings/McpOAuthCallbackScreen.logic'

describe('describeCallbackFailure', () => {
  it('reads the refusal from the envelope on ApiError.body', () => {
    const error = new ApiError(403, {
      error: {
        code: 'forbidden',
        message: 'This action requires the secrets.manage permission',
        requestId: 'req-42',
      },
    })

    expect(describeCallbackFailure(error)).toEqual({
      kind: 'api',
      failure: {
        descriptionKey: 'errors.generic.description.forbidden',
        message: 'This action requires the secrets.manage permission',
        issues: [],
        reason: null,
        requestId: 'req-42',
      },
      restartHint: true,
    })
  })

  it('maps a grant refusal reason ahead of the status class', () => {
    const error = new ApiError(422, {
      error: {
        code: 'validation',
        message: 'This authorization request is invalid or has expired',
        details: { reason: 'oauth_state_invalid' },
      },
    })

    expect(describeCallbackFailure(error)).toMatchObject({
      failure: { descriptionKey: 'errors.reason.description.oauth_state_invalid' },
      restartHint: true,
    })
  })

  it('drops the restart hint where starting again cannot help', () => {
    for (const reason of ['tool_server_without_oauth', 'oauth_started_by_other_user']) {
      const error = new ApiError(422, {
        error: { code: 'validation', message: 'refused', details: { reason } },
      })
      expect(describeCallbackFailure(error), reason).toMatchObject({ restartHint: false })
    }
  })
})
