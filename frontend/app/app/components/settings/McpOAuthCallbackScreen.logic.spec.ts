import { describe, expect, it } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { describeCallbackFailure } from '~/components/settings/McpOAuthCallbackScreen.logic'

const formatRequestId = (id: string) => `Request ID ${id}`

describe('describeCallbackFailure', () => {
  it('reads the refusal from the envelope on ApiError.body', () => {
    const error = new ApiError(403, {
      error: {
        code: 'forbidden',
        message: 'This action requires the secrets.manage permission',
        requestId: 'req-42',
      },
    })

    expect(describeCallbackFailure(error, formatRequestId)).toEqual({
      kind: 'api',
      descriptionKey: 'errors.generic.description.forbidden',
      detail: 'This action requires the secrets.manage permission · Request ID req-42',
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

    expect(describeCallbackFailure(error, formatRequestId)).toMatchObject({
      descriptionKey: 'errors.reason.description.oauth_state_invalid',
      restartHint: true,
    })
  })

  it('drops the restart hint where starting again cannot help', () => {
    for (const reason of ['tool_server_without_oauth', 'oauth_started_by_other_user']) {
      const error = new ApiError(422, {
        error: { code: 'validation', message: 'refused', details: { reason } },
      })
      expect(describeCallbackFailure(error, formatRequestId), reason).toMatchObject({
        restartHint: false,
      })
    }
  })

  it('describes a request that reached no server as a network fault', () => {
    expect(describeCallbackFailure(new TypeError('Failed to fetch'), formatRequestId)).toEqual({
      kind: 'api',
      descriptionKey: 'errors.generic.description.network',
      detail: 'Failed to fetch',
      restartHint: true,
    })
  })
})
